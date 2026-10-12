const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { DownloadService, safeFilename, uniquePath } = require('../electron/services/downloadService');
const { isChatDownloadUrl } = require('../electron/chatViewController');

test('attachment names are sanitized and cannot escape the workspace', () => {
  assert.equal(safeFilename('..\\bad:name?.docx'), '.._bad_name_.docx');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'download-service-'));
  const first = uniquePath(root, '..\\report.docx');
  assert.equal(path.dirname(first), root);
  fs.writeFileSync(first, 'one');
  assert.match(path.basename(uniquePath(root, '..\\report.docx')), /\(1\)\.docx$/);
});

test('download URLs retain attachment sessions without treating login or normal links as files', () => {
  for (const url of ['blob:https://chatgpt.com/fixture', 'https://chatgpt.com/backend-api/files/fixture/download', 'https://chatgpt.com/backend-api/files/download/fixture', 'https://files.oaiusercontent.com/fixture']) assert.equal(isChatDownloadUrl(url), true, url);
  for (const url of ['blob:https://evil.test/fixture', 'file:///secret.txt', 'https://chatgpt.com/auth/login', 'https://chatgpt.com/c/fixture', 'https://files.oaiusercontent.com.evil.test/fixture', 'http://files.oaiusercontent.com/fixture']) assert.equal(isChatDownloadUrl(url), false, url);
});

test('a save path error is reported and cancelled rather than escaping the download callback', () => {
  const states = [], session = new EventEmitter(), item = new EventEmitter();
  let cancelled = false;
  Object.assign(item, { getFilename: () => 'fixture.txt', setSavePath: () => { throw new Error('Access denied'); }, cancel: () => { cancelled = true; } });
  new DownloadService({ electronSession: session, settings: { load: () => ({ workspace: os.tmpdir() }) }, log: { warn() {} }, onState: (state) => states.push(state) }).bind();
  assert.doesNotThrow(() => session.emit('will-download', {}, item));
  assert.equal(cancelled, true);
  assert.match(states.at(-1).error, /Access denied/);
});

test('a Blob without a suggested extension remains a usable document filename', () => {
  const session = new EventEmitter(), item = new EventEmitter();
  let destination;
  Object.assign(item, { getFilename: () => 'fixture-blob', getMimeType: () => 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', setSavePath: (value) => { destination = value; }, getTotalBytes: () => 20 });
  new DownloadService({ electronSession: session, settings: { load: () => ({ workspace: os.tmpdir() }) }, log: {}, onState() {} }).bind();
  session.emit('will-download', {}, item);
  assert.match(destination, /fixture-blob(?: \(\d+\))?\.docx$/);
});

test('interrupted and cancelled downloads publish actionable failure states', () => {
  for (const status of ['interrupted', 'cancelled']) {
    const states = [], session = new EventEmitter(), item = new EventEmitter();
    Object.assign(item, { getFilename: () => 'fixture.txt', setSavePath() {}, getTotalBytes: () => 20 });
    new DownloadService({ electronSession: session, settings: { load: () => ({ workspace: os.tmpdir() }) }, log: { warn() {} }, onState: (state) => states.push(state) }).bind();
    session.emit('will-download', {}, item);
    item.emit('done', {}, status);
    assert.equal(states.at(-1).status, status);
    assert.ok(states.at(-1).error);
  }
});
