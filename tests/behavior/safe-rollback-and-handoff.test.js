const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  createCheckpoint,
  rollbackCheckpoint,
  taskFilePaths,
  isProtectedRel,
} = require('../../electron/services/safeCheckpoint');
const { ContextUsageTracker } = require('../../electron/services/contextUsageTracker');
const { ApprovalStore } = require('../../electron/services/approvalStore');
const { writeHandoffFile } = require('../../electron/services/handoffService');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function setupRepo() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mywebgpt-safe-ckpt-')));
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 't@example.com']);
  git(root, ['config', 'user.name', 'T']);
  fs.writeFileSync(path.join(root, 'base.txt'), 'committed-base\n');
  fs.writeFileSync(path.join(root, 'clean.txt'), 'clean\n');
  git(root, ['add', '--', 'base.txt', 'clean.txt']);
  git(root, ['commit', '-m', 'init']);
  return root;
}

function rmrf(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

test('safe checkpoint restores task edits and preserves unrelated user dirty files', async (t) => {
  const root = setupRepo();
  t.after(() => rmrf(root));

  // Pre-task dirty baseline on base.txt (user had local edits before AI).
  fs.writeFileSync(path.join(root, 'base.txt'), 'user-pre-task\n');
  // Unrelated dirty file never in task modified list.
  fs.writeFileSync(path.join(root, 'clean.txt'), 'user-unrelated-dirty\n');

  const meta = await createCheckpoint(root, { taskId: 'task1', manual: true });
  assert.equal(meta.rollback_mode, 'three-way-baseline');
  assert.ok(meta.fileSnapshots['base.txt']);
  assert.ok(meta.fileSnapshots['clean.txt']);

  // Task modifies base.txt and creates task-new.txt.
  fs.writeFileSync(path.join(root, 'base.txt'), 'ai-changed\n');
  fs.writeFileSync(path.join(root, 'task-new.txt'), 'created-by-task\n');

  const result = await rollbackCheckpoint(root, meta, {
    taskState: { modified_files: ['base.txt', 'task-new.txt'] },
  });

  assert.equal(result.success, true, JSON.stringify(result));
  assert.ok(result.restoredFiles.includes('base.txt'));
  assert.ok(result.removedFiles.includes('task-new.txt'));
  // Unrelated dirty file must remain user content, not wiped.
  assert.equal(fs.readFileSync(path.join(root, 'clean.txt'), 'utf8'), 'user-unrelated-dirty\n');
  // Task-owned dirty file restored to pre-task baseline (user-pre-task), not HEAD committed-base.
  assert.equal(fs.readFileSync(path.join(root, 'base.txt'), 'utf8'), 'user-pre-task\n');
  // Index untouched.
  const staged = git(root, ['diff', '--cached', '--name-only']).trim();
  assert.equal(staged, '');
});

test('safe rollback leaves post-checkpoint user edit as conflict when not in task list', async (t) => {
  const root = setupRepo();
  t.after(() => rmrf(root));

  fs.writeFileSync(path.join(root, 'base.txt'), 'pre\n');
  const meta = await createCheckpoint(root, { taskId: 'task2', manual: true });
  // AI does not touch base.txt; user later edits it (not in task modified_files).
  fs.writeFileSync(path.join(root, 'base.txt'), 'user-after\n');

  const result = await rollbackCheckpoint(root, meta, {
    taskState: { modified_files: [] },
  });
  assert.ok(result.conflicts.some((c) => c.path === 'base.txt'));
  assert.equal(fs.readFileSync(path.join(root, 'base.txt'), 'utf8'), 'user-after\n');
});

test('safe rollback can recover clean-before-task file via checkout-index for that path only', async (t) => {
  const root = setupRepo();
  t.after(() => rmrf(root));

  // clean.txt is clean at baseline → not in dirty snapshot.
  const meta = await createCheckpoint(root, { taskId: 'task3', manual: true });
  assert.equal(meta.fileSnapshots['clean.txt'], undefined);

  fs.writeFileSync(path.join(root, 'clean.txt'), 'ai-dirty\n');
  // Pre-staged unrelated file must survive pathspec checkout-index.
  fs.writeFileSync(path.join(root, 'base.txt'), 'also-dirty\n');
  git(root, ['add', '--', 'base.txt']);

  const result = await rollbackCheckpoint(root, meta, {
    taskState: { modified_files: ['clean.txt'] },
  });
  assert.ok(result.restoredFiles.includes('clean.txt') || result.skipped.some((s) => s.path === 'clean.txt'));
  // clean.txt should be back to committed content if recovered.
  if (result.restoredFiles.includes('clean.txt')) {
    const restored = fs.readFileSync(path.join(root, 'clean.txt'), 'utf8').replace(/\r\n/g, '\n');
    assert.equal(restored, 'clean\n');
  }
  // Pre-staged base.txt content/index must not be reset by clean.txt recovery.
  const staged = git(root, ['diff', '--cached', '--name-only']).trim();
  assert.equal(staged, 'base.txt');
});

test('ContextUsageTracker does not apply session A baseline to session B', () => {
  const tracker = new ContextUsageTracker();
  const sessionA = {
    current_session_id: 'session-A',
    tool_calls: 10,
    request_bytes: 16000,
    response_bytes: 16000,
    recent: [{ tool: 'read_file', request_bytes: 3200, response_bytes: 0 }],
  };
  tracker.setSessionBaseline(sessionA);
  assert.equal(tracker.sessionBaseline.sessionId, 'session-A');

  // Session B has real small usage; must not be zeroed by A's baseline.
  const sessionB = {
    current_session_id: 'session-B',
    tool_calls: 1,
    request_bytes: 3200,
    response_bytes: 0,
    recent: [{ tool: 'read_file', request_bytes: 3200, response_bytes: 0 }],
  };
  const snap = tracker.syncWithRuntime(sessionB);
  assert.equal(snap.callCount, 1);
  assert.ok(snap.totalBytes >= 3200, `expected >=3200 bytes, got ${snap.totalBytes}`);
  assert.ok(snap.totalTokens > 0, `expected >0 tokens, got ${snap.totalTokens}`);
});

test('ApprovalStore issues, consumes once, rejects reuse and expiry', () => {
  const store = new ApprovalStore({ ttlMs: 50 });
  const rec = store.issue({ action: 'checkpoint:rollback', scopeRoot: process.cwd(), taskId: 't1' });
  const first = store.consume(rec.id, { action: 'checkpoint:rollback', scopeRoot: process.cwd() });
  assert.equal(first.ok, true);
  const second = store.consume(rec.id, { action: 'checkpoint:rollback' });
  assert.equal(second.ok, false);

  const expiring = store.issue({ action: 'git:commit', scopeRoot: process.cwd() });
  // Force expire
  store.items.get(expiring.id).expiresAt = Date.now() - 1;
  const late = store.consume(expiring.id, { action: 'git:commit' });
  assert.equal(late.ok, false);
  assert.match(late.error, /过期/);
});

test('handoff file is written before snapshot claims inheritance', async (t) => {
  const root = setupRepo();
  t.after(() => rmrf(root));
  const written = await writeHandoffFile(root, {
    objective: '修复停止按钮',
    currentStep: '核对 kill 路径',
    modifiedFiles: ['electron/main.js'],
    gitStatus: ' M electron/main.js',
    failedCommands: ['npm test -- --fail'],
    unverified: ['GUI 未验收'],
    nextSteps: ['补进程退出行为测试'],
    baselineHead: 'abc123',
  });
  assert.ok(fs.existsSync(written.path));
  const content = fs.readFileSync(written.path, 'utf8');
  assert.match(content, /# 任务交接记录/);
  assert.match(content, /修复停止按钮/);
  assert.match(content, /GUI 未验收/);
  assert.match(content, /不要仅凭提示词假设任务已完成/);
});

test('taskFilePaths skips protected coding-tools paths', () => {
  const paths = taskFilePaths({
    modified_files: ['src/a.js', '.coding-tools/task-state.json', { path: '.coding-tools/x' }, ''],
  });
  assert.deepEqual(paths, ['src/a.js']);
  assert.equal(isProtectedRel('.coding-tools/capsules/x'), true);
  assert.equal(isProtectedRel('src/a.js'), false);
});
