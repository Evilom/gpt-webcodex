const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { GoalModeService, localWorkIsIdle } = require('../electron/services/goalModeService');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'thinktank-goals-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const calls = [], controllers = [];
  let now = 100000, workspace = 'E:/projects', ready = true;
  let local = { health: { ready: true, active_commands: 0 }, task: { status: 'completed' }, operations: [] };
  function tab(id) {
    const page = { conversationId: id, documentId: 33, manualStops: 0, turnKey: '1:old:1:old', generating: false, blocked: '', draft: false, attachments: false, hasReply: true, acknowledged: true };
    const controller = { page, loading: false, streamState: { status: 'healthy' }, streamConversationId: () => page.conversationId,
      inspectGoalPage: async () => ({ ...page }), armGoal() {}, cancelGoalSend() {},
      submitGoalPrompt: async options => { calls.push(options); return { sent: true }; } };
    controllers.push(controller); return controller;
  }
  const options = { file: path.join(directory, 'goal-mode.json'), controllers: () => controllers, workspace: () => workspace, localState: async () => local, connectionReady: async () => ready, now: () => now };
  const service = new GoalModeService(options);
  return { service, options, tab, calls, advance: (ms = 16000) => { now += ms; }, local: value => { local = value; }, ready: value => { ready = value; }, workspace: value => { workspace = value; } };
}

test('native error overrides the real incident’s false healthy status; a single checked continuation is sent', async t => {
  const f = fixture(t), tab = f.tab('incident');
  tab.page.error = 'message-stream'; // Native UI error, observer incorrectly reported finished at 08:38:46.
  await f.service.start(tab, { objective: '核查现有成果后完成交付' });
  await f.service.tick(); f.advance(); await f.service.tick();
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0].text, /只读核对/);
  assert.match(f.calls[0].text, /不要重复执行/);
  tab.page.generating = true;
  f.advance(600000); await f.service.tick(); await f.service.tick();
  assert.equal(f.calls.length, 1, 'quiet long thinking is never retried');
});

test('local workflow completion alone cannot interrupt a generating page', async t => {
  const f = fixture(t), tab = f.tab('thinking'); tab.page.generating = true;
  await f.service.start(tab, { objective: '完成整个目标' });
  await f.service.tick(); f.advance(999999); await f.service.tick();
  assert.equal(f.calls.length, 0);
});

test('invalid conversation bodies pause the goal without sending or claiming completion', async t => {
  const f = fixture(t), tab = f.tab('invalid-body');
  tab.page.error = 'invalid-conversation-body';
  tab.page.done = true;
  await f.service.start(tab, { objective: '保留成果后继续' });
  await f.service.tick(); f.advance(3600000); await f.service.tick();
  assert.equal(f.calls.length, 0);
  assert.equal(f.service.stateFor('invalid-body').status, 'paused');
  assert.match(f.service.stateFor('invalid-body').reason, /对话请求内容无效/);
});

test('unknown, busy and queued local work or offline transport cannot trigger a new message', async t => {
  const f = fixture(t), tab = f.tab('busy');
  await f.service.start(tab, { objective: '交付' }); await f.service.tick(); f.advance();
  for (const local of [undefined, { health: { ready: true, active_commands: 1 }, operations: [] }, { health: { ready: true, active_commands: 0 }, operations: [{ status: 'queued' }] }]) {
    f.local(local); await f.service.tick(); assert.equal(f.calls.length, 0);
  }
  f.local({ health: { ready: true, active_commands: 0 }, operations: [] }); f.ready(false);
  await f.service.tick(); assert.equal(f.calls.length, 0);
  f.ready(true); await f.service.tick(); assert.equal(f.calls.length, 1);
});

test('drafts, attachments, recent editing and approval cards are preserved', async t => {
  const f = fixture(t), tab = f.tab('draft');
  await f.service.start(tab, { objective: '交付' });
  for (const field of ['draft', 'attachments', 'editing', 'blocked']) {
    tab.page[field] = field === 'blocked' ? '等待网页授权' : true;
    await f.service.tick(); f.advance(); await f.service.tick();
    assert.equal(f.calls.length, 0); tab.page[field] = false;
  }
});

test('completion is acknowledged only for the current goal’s own sent turn', async t => {
  const f = fixture(t), tab = f.tab('goal'); tab.page.done = true;
  await f.service.start(tab, { objective: '完成验收' });
  await f.service.tick(); f.advance(); await f.service.tick();
  assert.equal(f.calls.length, 1, 'an old completion claim cannot complete a newly enabled goal');
  await f.service.tick(); assert.equal(f.service.stateFor('goal').status, 'completed');
  f.advance(); await f.service.tick(); assert.equal(f.calls.length, 1);
});

test('manual stop, navigation, changed workspace and intervening user messages pause continuation', async t => {
  for (const kind of ['stop', 'navigation', 'workspace', 'message']) {
    const f = fixture(t), tab = f.tab(kind);
    await f.service.start(tab, { objective: '交付' });
    if (kind === 'stop') tab.page.manualStops++;
    if (kind === 'navigation') tab.page.documentId++;
    if (kind === 'workspace') f.workspace('E:/other');
    if (kind === 'message') { f.service.goals.get(kind).awaitingReply = true; tab.page.acknowledged = false; }
    await f.service.tick(); f.advance(); await f.service.tick();
    assert.equal(f.service.stateFor(kind).status, 'paused'); assert.equal(f.calls.length, 0);
  }
});

test('uncertain delivery is persisted, paused and never automatically replayed after restart', async t => {
  const f = fixture(t), tab = f.tab('uncertain');
  tab.submitGoalPrompt = async options => { f.calls.push(options); return { uncertain: true }; };
  await f.service.start(tab, { objective: '交付' }); await f.service.tick(); f.advance(); await f.service.tick();
  assert.equal(f.service.stateFor('uncertain').status, 'paused');
  const restored = new GoalModeService(f.options);
  f.advance(3600000); await restored.tick(); assert.equal(f.calls.length, 1);
  tab.page.acknowledged = false;
  await assert.rejects(() => restored.resume(tab), /不可确认/);
  assert.equal(f.calls.length, 1);
});

test('each conversation has independent completion and errors; budgets bound repeated failures', async t => {
  const f = fixture(t), a = f.tab('a'), b = f.tab('b');
  await f.service.start(a, { objective: 'A', maxRounds: 2 }); await f.service.start(b, { objective: 'B' });
  await f.service.tick(); f.advance(); await f.service.tick();
  a.page.done = true; await f.service.tick();
  assert.equal(f.service.stateFor('a').status, 'completed'); assert.equal(f.service.stateFor('b').status, 'running');
  f.advance(); await f.service.tick();
  b.page.error = 'message-stream';
  for (let i = 0; i < 5; i++) { await f.service.tick(); f.advance(90000); await f.service.tick(); }
  assert.equal(f.service.stateFor('b').status, 'paused');
  assert.equal(f.service.stateFor('b').errors, 3);
  assert.equal(f.calls.filter(call => call.conversationId === 'a').length, 1);
});

test('app restart pauses a running goal rather than assuming an old reply is complete', async t => {
  const f = fixture(t), tab = f.tab('restart'); await f.service.start(tab, { objective: '保存目标' });
  const restored = new GoalModeService(f.options); await restored.tick();
  assert.equal(restored.stateFor('restart').status, 'paused'); assert.equal(f.calls.length, 0);
});

test('health without authenticated active command evidence is not idle', () => {
  assert.equal(localWorkIsIdle({ health: { ready: true }, operations: [] }), false);
  assert.equal(localWorkIsIdle({ health: { ready: true, active_commands: 0 }, task: { current_command: { status: 'running' } }, operations: [] }), false);
  assert.equal(localWorkIsIdle({ health: { ready: true, active_commands: 0 }, task: { lifecycle_state: 'waiting_user' }, operations: [] }), false);
});

test('an unobservable tab does not block another goal, and a pause during health verification wins', async t => {
  const f = fixture(t), a = f.tab('unobservable'), b = f.tab('available');
  await f.service.start(a, { objective: 'A' }); await f.service.start(b, { objective: 'B' });
  a.inspectGoalPage = async () => { throw new Error('renderer unavailable'); };
  await f.service.tick(); f.advance(); await f.service.tick();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].conversationId, 'available');
  b.page.error = 'message-stream'; await f.service.tick(); f.advance();
  f.service.localState = async () => { f.service.pause('available'); return { health: { ready: true, active_commands: 0 }, operations: [] }; };
  await f.service.tick(); assert.equal(f.calls.length, 1); assert.equal(f.service.stateFor('available').status, 'paused');
});

test('round limits pause without misreporting the objective as complete', async t => {
  const f = fixture(t), tab = f.tab('limit');
  await f.service.start(tab, { objective: '还有剩余步骤', maxRounds: 1 });
  await f.service.tick(); f.advance(); await f.service.tick(); await f.service.tick();
  assert.equal(f.calls.length, 1); assert.equal(f.service.stateFor('limit').status, 'paused');
});
