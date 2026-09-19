const path = require('node:path');
const { run } = require('./commandRunner');

function isPathInside(root, fullPath) {
  const normalizedRoot = path.resolve(String(root || ''));
  const normalizedFull = path.resolve(String(fullPath || ''));
  if (normalizedFull === normalizedRoot) return true;
  const rootPrefix = normalizedRoot.endsWith(path.sep) ? normalizedRoot : `${normalizedRoot}${path.sep}`;
  return normalizedFull.startsWith(rootPrefix);
}

function isProtectedRel(rel) {
  const normalized = String(rel || '').replace(/\\/g, '/').replace(/^\.\/+/, '');
  return !normalized
    || normalized === '.'
    || normalized.startsWith('.coding-tools/')
    || normalized === '.coding-tools';
}

function normalizeCommitFiles(root, files) {
  const safeFiles = [];
  const seen = new Set();
  for (const item of files || []) {
    const rel = String(typeof item === 'string' ? item : (item?.path || '')).trim();
    if (!rel) continue;
    const normalized = rel.replace(/\\/g, '/').replace(/^\.\/+/, '');
    if (!normalized || seen.has(normalized) || isProtectedRel(normalized)) continue;
    const full = path.isAbsolute(normalized) ? path.resolve(normalized) : path.resolve(root, normalized);
    if (!isPathInside(root, full)) {
      throw new Error(`提交文件路径越界：${rel}`);
    }
    seen.add(normalized);
    safeFiles.push(normalized);
  }
  return safeFiles;
}

async function stageAndCommit(root, { message, files, push = false }) {
  const trimmedMessage = String(message || '').trim();
  if (!trimmedMessage) throw new Error('请输入提交信息（Commit Message）。');
  const safeFiles = normalizeCommitFiles(root, files);
  if (!safeFiles.length) {
    throw new Error(
      '未指定可提交文件，且当前任务没有已记录的修改文件。'
      + '为避免夹带仓库中无关改动，请在任务中记录修改文件，或在提交时显式选择文件。'
    );
  }

  await run('git', ['add', '--', ...safeFiles], { cwd: root, timeoutMs: 15000 });
  const stagedRes = await run(
    'git',
    ['diff', '--cached', '--name-only', '--', ...safeFiles],
    { cwd: root, timeoutMs: 5000 }
  );
  const stagedFiles = stagedRes.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!stagedFiles.length) {
    throw new Error(`所选文件在 git add 后没有可提交的变更：${safeFiles.join(', ')}`);
  }

  // Pathspec commit keeps unrelated pre-staged changes out of this commit.
  const commitRes = await run(
    'git',
    ['commit', '-m', trimmedMessage, '--', ...safeFiles],
    { cwd: root, timeoutMs: 15000 }
  );

  let pushOutput = '';
  if (push) {
    try {
      const pushRes = await run('git', ['push'], { cwd: root, timeoutMs: 25000 });
      pushOutput = pushRes.stdout || pushRes.stderr || '推送成功';
    } catch (pushErr) {
      throw new Error(`提交成功，但推送到远程失败：${pushErr.message}`);
    }
  }

  const branchRes = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, timeoutMs: 3000 });
  return {
    commit: commitRes.stdout || '提交成功',
    push: pushOutput,
    files: safeFiles,
    staged_files: stagedFiles,
    branch: branchRes.stdout.trim(),
    pushed: Boolean(push && pushOutput),
  };
}

module.exports = {
  isPathInside,
  isProtectedRel,
  normalizeCommitFiles,
  stageAndCommit,
};
