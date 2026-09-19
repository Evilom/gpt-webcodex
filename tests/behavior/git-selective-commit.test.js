const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { stageAndCommit, normalizeCommitFiles, isPathInside, isProtectedRel } = require('../../electron/services/safeGitOps');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function setupRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mywebgpt-safe-commit-'));
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test User']);
  fs.writeFileSync(path.join(root, 'base.txt'), 'base\n');
  fs.writeFileSync(path.join(root, 'unrelated.txt'), 'unrelated-before\n');
  git(root, ['add', '--', 'base.txt', 'unrelated.txt']);
  git(root, ['commit', '-m', 'init']);
  // Dirty baseline user change before task starts.
  fs.writeFileSync(path.join(root, 'base.txt'), 'user-pre-task-edit\n');
  // Unrelated dirty file that must not be committed.
  fs.writeFileSync(path.join(root, 'unrelated.txt'), 'unrelated-dirty\n');
  // Task-owned change.
  fs.writeFileSync(path.join(root, 'task.txt'), 'task-change\n');
  return root;
}

function rmrf(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

test('normalizeCommitFiles rejects protected paths and path escape', () => {
  const root = process.cwd();
  assert.deepEqual(normalizeCommitFiles(root, ['.coding-tools/task-state.json']), []);
  assert.deepEqual(normalizeCommitFiles(root, ['.coding-tools']), []);
  assert.throws(() => normalizeCommitFiles(root, ['../outside.txt']), /越界/);
  assert.deepEqual(normalizeCommitFiles(root, ['ok.js']), ['ok.js']);
});

test('path boundary helper rejects sibling-prefix paths', () => {
  const root = path.resolve('C:/work/app');
  assert.equal(isPathInside(root, path.join(root, 'src/a.js')), true);
  assert.equal(isPathInside(root, 'C:/work/app-evil/x.js'), false);
  assert.equal(isProtectedRel('.coding-tools/capsules/x'), true);
  assert.equal(isProtectedRel('src/app.js'), false);
});

test('stageAndCommit only commits selected files and preserves dirty baseline', async (t) => {
  const root = setupRepo();
  t.after(() => rmrf(root));

  const result = await stageAndCommit(root, {
    message: 'test: task-only commit',
    files: ['task.txt'],
    push: false,
  });

  assert.equal(result.pushed, false);
  assert.deepEqual(result.files, ['task.txt']);

  const committed = git(root, ['show', '--name-only', '--pretty=format:', 'HEAD']).trim().split(/\r?\n/).filter(Boolean);
  assert.deepEqual(committed, ['task.txt']);

  const status = git(root, ['status', '--porcelain']);
  assert.match(status, /base\.txt/);
  assert.match(status, /unrelated\.txt/);
  assert.doesNotMatch(status, /task\.txt/);

  const baseContent = fs.readFileSync(path.join(root, 'base.txt'), 'utf8');
  assert.equal(baseContent, 'user-pre-task-edit\n');
  const unrelatedContent = fs.readFileSync(path.join(root, 'unrelated.txt'), 'utf8');
  assert.equal(unrelatedContent, 'unrelated-dirty\n');
});

test('stageAndCommit refuses empty selection instead of git add -A', async (t) => {
  const root = setupRepo();
  t.after(() => rmrf(root));
  await assert.rejects(
    stageAndCommit(root, { message: 'should fail', files: [], push: false }),
    /未指定可提交文件/
  );
  // Nothing should have been committed.
  const log = git(root, ['log', '--oneline', '-1']).trim();
  assert.match(log, /init/);
});

test('stageAndCommit does not fold pre-staged unrelated path into task commit', async (t) => {
  const root = setupRepo();
  t.after(() => rmrf(root));
  // User already staged an unrelated file before task commit.
  git(root, ['add', '--', 'unrelated.txt']);

  const result = await stageAndCommit(root, {
    message: 'test: pathspec commit',
    files: ['task.txt'],
    push: false,
  });
  assert.deepEqual(result.files, ['task.txt']);

  const committed = git(root, ['show', '--name-only', '--pretty=format:', 'HEAD']).trim().split(/\r?\n/).filter(Boolean);
  assert.deepEqual(committed, ['task.txt']);

  // Pre-staged unrelated change must still be staged, not silently committed.
  const staged = git(root, ['diff', '--cached', '--name-only']).trim().split(/\r?\n/).filter(Boolean);
  assert.ok(staged.includes('unrelated.txt'), `expected unrelated.txt still staged, got: ${staged.join(',')}`);
});
