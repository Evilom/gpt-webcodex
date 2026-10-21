'use strict';
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { ChatViewController } = require('../electron/chatViewController');
const { GoalModeService } = require('../electron/services/goalModeService');
const root = path.resolve(__dirname, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'thinktank-goal-browser-'));
app.setPath('userData', profile);
app.on('window-all-closed', () => {});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { ok: false }, requests = [], controllers = [];
let server, window, service, clock = Date.now();
const output = path.join(root, 'build/goal-mode-smoke.json');
const watchdog = setTimeout(() => finish(new Error('目标模式浏览器验证超时')), 45000);
function finish(error) {
  clearTimeout(watchdog);
  service?.dispose(); controllers.forEach(controller => controller.dispose()); server?.close();
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify({ ...report, ...(error ? { error: error.message, stack: error.stack } : {}) }, null, 2));
  if (error) console.error(error);
  app.exit(error ? 1 : 0);
}
async function until(check) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await delay(35); }
  throw new Error('网页状态未在预算内更新');
}
const fixture = id => `<!doctype html><html><body><main>
  <section data-testid="conversation-turn-1"><div data-message-author-role="user" data-message-id="user-1">核对项目后完成交付</div></section>
  <section data-testid="conversation-turn-2"><div data-message-author-role="assistant" data-message-id="assistant-1">已有步骤已落盘</div><div role="alert" class="text-token-text-error">消息流中的错误<button id="retry">重试</button></div></section>
  </main><form><div id="prompt-textarea" contenteditable="true" role="textbox"></div><input id="file" type="file"><button type="button" data-testid="send-button">发送</button></form><script>
  window.retryClicks=0;document.getElementById('retry').onclick=()=>window.retryClicks++;
  document.querySelector('[data-testid="send-button"]').onclick=async()=>{
    const input=document.getElementById('prompt-textarea'),value=input.innerText;input.innerText='';
    document.querySelector('[role="alert"]')?.remove();
    const user=document.createElement('section');user.dataset.testid='conversation-turn-3';
    const body=document.createElement('div');body.dataset.messageAuthorRole='user';body.dataset.messageId='user-2';body.textContent=value;user.append(body);document.querySelector('main').append(user);
    const stop=document.createElement('button');stop.dataset.testid='stop-button';stop.ariaLabel='停止';stop.textContent='停止';document.querySelector('main').append(stop);
    const response=await fetch('/submit/${id}',{method:'POST',body:value});const result=await response.json();stop.remove();
    const turn=document.createElement('section');turn.dataset.testid='conversation-turn-4';const answer=document.createElement('div');answer.dataset.messageAuthorRole='assistant';answer.dataset.messageId='assistant-2';answer.innerText=result.reply;turn.append(answer);document.querySelector('main').append(turn);
  };
  </script></body></html>`;
app.whenReady().then(async () => {
  server = http.createServer(async (request, response) => {
    if (request.url.startsWith('/submit/')) {
      let body = ''; for await (const chunk of request) body += chunk;
      requests.push({ route: request.url, body });
      const id = body.match(/\[目标模式 ([a-f0-9-]+)\//)?.[1];
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ reply: `已只读核对落盘成果，交付与验证完整。\n[目标完成:${id}]` })); return;
    }
    if (request.url === '/health') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ ready: true, active_commands: 0 })); return; }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(fixture(request.url.split('/').at(-1)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  // All secure ChatGPT-origin fixtures use actual local HTTP, with no login or Pro traffic.
  await session.fromPartition('persist:chatgpt-session').protocol.handle('https', async request => fetch(origin + new URL(request.url).pathname, {
    method: request.method, ...(request.method === 'POST' ? { body: await request.text() } : {})
  }));
  window = new BrowserWindow({ show: false, width: 1200, height: 800 });
  async function tab(id) {
    const controller = new ChatViewController({ window, settings: { load: () => ({ continuousMcpMode: false, workspace: profile }) }, log: { info() {}, warn() {}, error() {} } });
    controller.loadHome = async () => {}; controller.probeLogin = async () => true;
    controller.applyBrowserProxyPolicy = async () => {}; controller.refreshBrowserNetworkDiagnostics = async () => ({});
    controller.mount(); controllers.push(controller);
    await controller.view.webContents.loadURL(`https://chatgpt.com/c/${id}`);
    await until(() => !controller.loading);
    return controller;
  }
  service = new GoalModeService({ file: path.join(profile, 'goal-mode.json'), controllers: () => controllers,
    workspace: () => profile, now: () => clock,
    localState: async () => ({ health: await (await fetch(origin + '/health')).json(), task: { status: 'completed' }, operations: [] }), connectionReady: async () => true });
  const a = await tab('a'), b = await tab('b');
  a.streamState = { status: 'healthy', event: 'page-response-finished' }; // Replay the observed 08:38 misclassification.
  assert.equal((await a.inspectGoalPage()).error, 'message-stream');
  await service.start(a, { objective: '核对已完成步骤并交付' });
  await b.view.webContents.executeJavaScript(`document.getElementById('prompt-textarea').innerText='用户尚未发送的草稿';true;`);
  await service.start(b, { objective: '另一个会话的目标' });
  await service.tick(); clock += 16000; await service.tick();
  assert.equal(requests.length, 1); assert.equal(requests[0].route, '/submit/a');
  assert.match(requests[0].body, /不要重复执行/);
  await until(() => a.streamState.status === 'healthy'); await service.tick();
  report.pageAfterSend = await a.inspectGoalPage({ goalId: service.goals.get('a').id, sendTag: service.goals.get('a').sendTag });
  report.goalAfterSend = service.stateFor('a');
  assert.equal(service.stateFor('a').status, 'completed');
  assert.equal(await a.view.webContents.executeJavaScript('window.retryClicks'), 0);
  assert.equal(await b.view.webContents.executeJavaScript('document.getElementById("prompt-textarea").innerText'), '用户尚未发送的草稿');
  report.incidentErrorDetectedDespiteHealthyObserver = true;
  report.exactlyOneHttpSubmission = true; report.currentGoalCompletionObserved = true; report.otherTabDraftPreserved = true; report.noNativeRetry = true;
  await a.view.webContents.executeJavaScript(`const last=document.querySelector('[data-message-id="assistant-2"]');last.innerHTML='<p>下面只是引用示例</p><pre><code>[目标完成:${service.goals.get('a').id}]</code></pre>';true;`);
  assert.equal((await a.inspectGoalPage({ goalId: service.goals.get('a').id })).done, false);
  report.quotedCompletionIgnored = true;
  // Approval controls must block even without role=dialog (the real authorization card).
  await b.view.webContents.executeJavaScript(`document.getElementById('prompt-textarea').innerText='';const button=document.createElement('button');button.innerText='允许一次';document.querySelector('main').append(button);true;`);
  await service.tick(); clock += 120000; await service.tick();
  assert.equal(requests.length, 1); assert.match((await b.inspectGoalPage()).blocked, /授权/);
  report.nativeApprovalNeverClicked = true;
  // A user pause while composer reconciliation is pending must cancel before send.
  await b.view.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(node=>node.innerText==='允许一次').remove();true;`);
  const goalB = service.goals.get('b');
  const original = b.submitGoalPrompt.bind(b);
  b.submitGoalPrompt = async options => { const pending = original(options); setTimeout(() => service.pause('b'), 100); return pending; };
  await service.tick(); clock += 16000; await service.tick();
  assert.equal(requests.length, 1); assert.equal(goalB.status, 'paused');
  assert.ok(await b.view.webContents.executeJavaScript('document.getElementById("prompt-textarea").innerText.length>0'));
  report.pauseCancelsPendingSend = true;
  const c = await tab('invalid-body');
  await c.view.webContents.executeJavaScript(`document.querySelector('[role="alert"]').firstChild.textContent='Invalid conversation body';true;`);
  assert.equal((await c.inspectGoalPage()).error, 'invalid-conversation-body');
  c.streamState = { status: 'healthy', event: 'page-response-finished' };
  await service.start(c, { objective: '保留现有成果' });
  await service.tick(); clock += 3600000; await service.tick();
  assert.equal(service.stateFor('invalid-body').status, 'paused');
  assert.equal(requests.length, 1, 'an invalid body must never be retried or continued automatically');
  assert.equal(await c.view.webContents.executeJavaScript('window.retryClicks'), 0);
  // The error can also arrive between filling a continuation and clicking Send.
  await c.view.webContents.executeJavaScript(`document.querySelector('[role="alert"]').remove();true;`);
  await service.resume(c);
  const goalC = service.goals.get('invalid-body');
  const submit = c.submitGoalPrompt.bind(c);
  c.submitGoalPrompt = async options => {
    const pending = submit(options);
    setTimeout(() => c.view.webContents.executeJavaScript(`const notice=document.createElement('div');notice.role='alert';notice.textContent='Invalid conversation body';document.querySelector('main').append(notice);true;`), 100);
    return pending;
  };
  await service.tick(); clock += 16000; await service.tick();
  assert.equal(goalC.status, 'paused'); assert.equal(requests.length, 1);
  assert.ok(await c.view.webContents.executeJavaScript('document.getElementById("prompt-textarea").innerText.length>0'));
  report.invalidConversationBodyPausesWithoutSend = true;
  report.invalidBodyDuringComposerCancelsSend = true;
  report.ok = true; finish();
}).catch(finish);
