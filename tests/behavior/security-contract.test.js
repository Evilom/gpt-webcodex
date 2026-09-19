const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('desktop no longer rewrites task-state.json for pause/resume/stop', () => {
  const main = read('electron/main.js');
  // Must route through Runtime task_control instead of local status flips.
  assert.match(main, /secureHandle\('task-state:pause'[\s\S]*?callLocalMcpTool\('task_control'/);
  assert.match(main, /secureHandle\('task-state:resume'[\s\S]*?callLocalMcpTool\('task_control'/);
  assert.match(main, /secureHandle\('task-state:stop'[\s\S]*?callLocalMcpTool\('task_control'/);
  // Direct writeJsonAtomic of paused/stopped status must not remain in those handlers.
  assert.doesNotMatch(main, /state\.status = 'paused'[\s\S]{0,80}writeJsonAtomic\(statePath/);
  assert.doesNotMatch(main, /state\.status = 'stopped'[\s\S]{0,80}writeJsonAtomic\(statePath/);
});

test('command kill uses kill + session_id and fails loudly when process not confirmed', () => {
  const main = read('electron/main.js');
  assert.match(main, /command_control[\s\S]{0,200}action: 'kill'/);
  assert.match(main, /session_id/);
  assert.doesNotMatch(main, /command_control', \{ action: 'terminate' \}/);
  assert.match(main, /未能确认退出/);
  assert.match(main, /callLocalMcpTool\('command_control'/);
});

test('dangerous capsule rollback path is replaced by three-way baseline', () => {
  const main = read('electron/main.js');
  const browser = read('renderer/browser.js');
  const safeCheckpoint = read('electron/services/safeCheckpoint.js');
  // Old destructive restore path must be gone.
  assert.doesNotMatch(main, /git', \['checkout', 'HEAD', '--', rel\]/);
  assert.match(safeCheckpoint, /three-way-baseline/);
  assert.match(safeCheckpoint, /rollbackCheckpoint/);
  assert.match(safeCheckpoint, /conflicts/);
  // Safe path never resets index via checkout HEAD as primary restore.
  assert.doesNotMatch(safeCheckpoint, /git', \['checkout', 'HEAD', '--'/);
  assert.match(browser, /安全回滚/);
  assert.match(main, /createSafeCheckpoint/);
  assert.match(main, /rollbackSafeCheckpoint/);
});

test('commit no longer uses git add -A and is selective', () => {
  const main = read('electron/main.js');
  const safeGit = read('electron/services/safeGitOps.js');
  assert.doesNotMatch(main, /git', \['add', '-A'\]/);
  assert.doesNotMatch(safeGit, /git', \['add', '-A'\]/);
  assert.match(safeGit, /git', \['add', '--', \.\.\.safeFiles\]/);
  assert.match(safeGit, /\['commit', '-m', trimmedMessage, '--', \.\.\.safeFiles\]/);
  assert.match(safeGit, /stageAndCommit/);
});

test('runtime orchestrator stop does not swallow native.stop failure', () => {
  const orchestrator = read('electron/services/runtimeOrchestrator.js');
  assert.match(orchestrator, /native\.stop\(\)/);
  assert.doesNotMatch(orchestrator, /await this\.native\.stop\(\)\.catch\(\(\) => false\);[\s\S]{0,120}所有由本助手启动的服务均已停止/);
  assert.match(orchestrator, /未能完全停止/);
});

test('trusted renderer URL check uses path boundary not bare startsWith', () => {
  const main = read('electron/main.js');
  assert.match(main, /rendererPrefix/);
  assert.match(main, /function isPathInside/);
  assert.match(main, /assertPathInsideWorkspace/);
  // Bare rendererDir startsWith without separator must be gone.
  assert.doesNotMatch(main, /return normalizedFile\.startsWith\(rendererDir\);/);
});

test('mcp prepare/workspace bind task and instructions to resolved scope', () => {
  const server = read('resources/coding-tools-mcp/coding_tools_mcp/server.py');
  assert.match(server, /def _scope_binding/);
  assert.match(server, /bound_default_workspace/);
  // prepare_coding_context must not dump default project_context / task_state for other roots.
  assert.match(server, /task_resume": scope_binding\["task"\]/);
  assert.doesNotMatch(server, /"task_resume": self\.task_state\.get\(\)/);
  assert.match(server, /for item in scope_binding\["instructions_context"\]\.root_files/);
});
