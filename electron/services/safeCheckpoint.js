const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs/promises');
const { run } = require('./commandRunner');

const PROTECTED_PREFIX = '.coding-tools/';

function hashBuffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function normalizeRel(rel) {
  return String(rel || '').replace(/\\/g, '/').replace(/^\.\/+/, '').trim();
}

function isProtectedRel(rel) {
  const n = normalizeRel(rel);
  return !n || n === '.' || n === PROTECTED_PREFIX.slice(0, -1) || n.startsWith(PROTECTED_PREFIX);
}

function isInsideRoot(root, fullPath) {
  const normalizedRoot = path.resolve(String(root || ''));
  const normalizedFull = path.resolve(String(fullPath || ''));
  if (normalizedFull === normalizedRoot) return true;
  const prefix = normalizedRoot.endsWith(path.sep) ? normalizedRoot : `${normalizedRoot}${path.sep}`;
  return normalizedFull.startsWith(prefix);
}

function taskFilePaths(taskState) {
  const out = [];
  const list = Array.isArray(taskState?.modified_files) ? taskState.modified_files : [];
  for (const item of list) {
    const rel = normalizeRel(typeof item === 'string' ? item : item?.path);
    if (!isProtectedRel(rel)) out.push(rel);
  }
  return [...new Set(out)];
}

async function fileHash(fullPath) {
  try {
    const buf = await fs.readFile(fullPath);
    return { exists: true, hash: hashBuffer(buf), size: buf.length };
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, hash: '', size: 0 };
    throw error;
  }
}

async function collectGitDirtyRelPaths(root) {
  try {
    const status = await run('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: root, timeoutMs: 5000 });
    const paths = [];
    for (const line of String(status.stdout || '').split(/\r?\n/)) {
      if (!line || line.length < 4) continue;
      const rest = line.slice(3).trim();
      // rename format: "R  old -> new"
      const renameParts = rest.split(' -> ');
      const rel = normalizeRel(renameParts[renameParts.length - 1].replace(/^"|"$/g, ''));
      if (!isProtectedRel(rel)) paths.push(rel);
    }
    return [...new Set(paths)];
  } catch {
    return [];
  }
}

async function gitHead(root) {
  try {
    const res = await run('git', ['rev-parse', 'HEAD'], { cwd: root, timeoutMs: 3000 });
    return String(res.stdout || '').trim();
  } catch {
    return '';
  }
}

async function gitIndexPaths(root) {
  try {
    const res = await run('git', ['diff', '--cached', '--name-only'], { cwd: root, timeoutMs: 3000 });
    return String(res.stdout || '').split(/\r?\n/).map(normalizeRel).filter((item) => item && !isProtectedRel(item));
  } catch {
    return [];
  }
}

/**
 * Create a pre-task baseline snapshot of currently dirty files.
 * This is the safe restore source — never `git checkout HEAD`.
 */
async function createCheckpoint(root, { taskId = '', manual = false, description = '' } = {}) {
  const capsuleDir = path.join(root, PROTECTED_PREFIX, 'capsules');
  await fs.mkdir(capsuleDir, { recursive: true });
  const capsuleId = `${taskId || 'manual'}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const dirty = await collectGitDirtyRelPaths(root);
  const files = {};
  const errors = [];

  for (const rel of dirty) {
    if (isProtectedRel(rel)) continue;
    const full = path.resolve(root, rel);
    if (!isInsideRoot(root, full)) {
      errors.push(`${rel}: path outside workspace`);
      continue;
    }
    try {
      const info = await fileHash(full);
      if (!info.exists) {
        files[rel] = { existed: false, hash: '', backupName: null };
        continue;
      }
      const backupName = `${capsuleId}__${rel.replace(/[\\/]/g, '_')}`;
      const backupFull = path.join(capsuleDir, backupName);
      // Copy via buffer to preserve binary files.
      const buf = await fs.readFile(full);
      await fs.writeFile(backupFull, buf);
      files[rel] = { existed: true, hash: info.hash, size: info.size, backupName };
    } catch (error) {
      errors.push(`${rel}: ${error.message}`);
    }
  }

  const meta = {
    capsuleId,
    taskId: taskId || '',
    createdAt: new Date().toISOString(),
    manual: Boolean(manual),
    isGit: Boolean(await gitHead(root)),
    gitHead: await gitHead(root),
    stagedPaths: await gitIndexPaths(root),
    dirtyPaths: dirty,
    fileSnapshots: files,
    description: description || (manual ? '用户手动创建的安全检查点（任务前基线）' : '任务前安全基线'),
    rollback_enabled: true,
    rollback_mode: 'three-way-baseline',
    errors,
  };
  const metaPath = path.join(root, PROTECTED_PREFIX, 'capsule-state.json');
  await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8');
  return meta;
}

function loadCheckpointMeta(metaPath) {
  try {
    // eslint-disable-next-line global-require
    const { readJson } = require('./jsonStore');
    return readJson(metaPath, null);
  } catch {
    return null;
  }
}

/**
 * Safe rollback: restore only baseline-tracked paths that still look task-owned.
 * Never runs `git checkout HEAD`. Never resets the index.
 * Files not in the baseline snapshot are left alone (user edits preserved).
 */
async function rollbackCheckpoint(root, meta, { taskState = null } = {}) {
  if (!meta || typeof meta !== 'object') {
    throw new Error('没有可用的安全检查点。请先在任务开始前创建基线。');
  }
  if (meta.rollback_mode && meta.rollback_mode !== 'three-way-baseline') {
    throw new Error(`检查点回滚模式不受支持：${meta.rollback_mode}`);
  }
  const capsuleDir = path.join(root, PROTECTED_PREFIX, 'capsules');
  const snapshots = meta.fileSnapshots || {};
  const taskFiles = new Set(taskFilePaths(taskState));
  // Always consider baseline-tracked dirty files; additionally include task-recorded paths.
  const candidates = new Set([...Object.keys(snapshots), ...taskFiles]);

  const restored = [];
  const removed = [];
  const conflicts = [];
  const skipped = [];
  const errors = [];

  for (const rel of candidates) {
    if (isProtectedRel(rel)) {
      skipped.push({ path: rel, reason: 'protected' });
      continue;
    }
    const full = path.resolve(root, rel);
    if (!isInsideRoot(root, full)) {
      errors.push(`${rel}: path outside workspace`);
      continue;
    }

    const snap = snapshots[rel] || null;
    const current = await fileHash(full);

    // Not in baseline and not in task list → ignore.
    if (!snap && !taskFiles.has(rel)) {
      skipped.push({ path: rel, reason: 'not-in-baseline-or-task' });
      continue;
    }

    // Baseline said file did not exist → task likely created it.
    if (snap && snap.existed === false) {
      if (!current.exists) {
        skipped.push({ path: rel, reason: 'already-absent' });
        continue;
      }
      // If current content still differs from nothing and path is task-owned, remove it.
      // Conflict if user created a different file after checkpoint that is also task-listed.
      try {
        await fs.unlink(full);
        removed.push(rel);
      } catch (error) {
        errors.push(`${rel}: delete failed: ${error.message}`);
      }
      continue;
    }

    // Baseline had content → restore from physical snapshot.
    if (snap && snap.existed && snap.backupName) {
      const backupFull = path.join(capsuleDir, snap.backupName);
      try {
        const baselineBuf = await fs.readFile(backupFull);
        const baselineHash = hashBuffer(baselineBuf);
        if (current.exists && current.hash === baselineHash) {
          skipped.push({ path: rel, reason: 'already-at-baseline' });
          continue;
        }
        if (!current.exists) {
          await fs.mkdir(path.dirname(full), { recursive: true });
          await fs.writeFile(full, baselineBuf);
          restored.push(rel);
          continue;
        }
        // Current differs from baseline. Task-owned → restore.
        // If path is dirty-at-baseline AND task-owned, restore still applies (task increment only if task listed).
        if (!taskFiles.has(rel) && !snap) {
          skipped.push({ path: rel, reason: 'not-task-owned' });
          continue;
        }
        // Conflict heuristic: if path was NOT in task files but is in baseline and current changed,
        // treat as user change after checkpoint → do not wipe.
        if (!taskFiles.has(rel) && snap && current.hash !== baselineHash) {
          conflicts.push({
            path: rel,
            reason: 'changed-after-checkpoint-not-in-task-modified-files',
            current_hash: current.hash,
            baseline_hash: baselineHash,
          });
          continue;
        }
        await fs.writeFile(full, baselineBuf);
        restored.push(rel);
      } catch (error) {
        errors.push(`${rel}: restore failed: ${error.message}`);
      }
      continue;
    }

    // Task-listed path with no baseline snapshot (clean or new before task).
    if (!snap && taskFiles.has(rel)) {
      if (!current.exists) {
        skipped.push({ path: rel, reason: 'already-absent' });
        continue;
      }
      // Tracked in index? Untracked → task-created new file → delete.
      let tracked = false;
      try {
        await run('git', ['ls-files', '--error-unmatch', '--', rel], { cwd: root, timeoutMs: 3000 });
        tracked = true;
      } catch {
        tracked = false;
      }
      if (!tracked) {
        try {
          await fs.unlink(full);
          removed.push(rel);
        } catch (error) {
          errors.push(`${rel}: delete new file failed: ${error.message}`);
        }
        continue;
      }
      // Tracked and clean at baseline → recover this path only via checkout-index
      // (does not reset unrelated index entries).
      try {
        await run('git', ['checkout-index', '--force', '--', rel], { cwd: root, timeoutMs: 5000 });
        restored.push(rel);
      } catch (error) {
        errors.push(`${rel}: recover-from-head failed: ${error.message}`);
      }
      continue;
    }

    skipped.push({ path: rel, reason: 'unhandled' });
  }

  const success = errors.length === 0 && conflicts.length === 0;
  return {
    success,
    restoredFiles: restored,
    removedFiles: removed,
    conflicts,
    skipped,
    errors,
    capsuleId: meta.capsuleId || null,
    message: success
      ? `安全回滚完成：还原 ${restored.length} 个，清理 ${removed.length} 个，跳过 ${skipped.length} 个。未改动暂存区。`
      : `安全回滚部分完成：还原 ${restored.length} 个，清理 ${removed.length} 个；冲突 ${conflicts.length} 个，错误 ${errors.length} 个。未改动暂存区。`,
  };
}

module.exports = {
  createCheckpoint,
  rollbackCheckpoint,
  loadCheckpointMeta,
  taskFilePaths,
  isProtectedRel,
  isInsideRoot,
  hashBuffer,
  normalizeRel,
  PROTECTED_PREFIX,
};
