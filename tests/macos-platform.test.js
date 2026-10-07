const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load(relative, platform, modules = {}) {
  const module = { exports: {} };
  const mockProcess = Object.create(process);
  Object.defineProperty(mockProcess, 'platform', { value: platform });
  Object.defineProperty(mockProcess, 'env', { value: {} });
  Object.defineProperty(mockProcess, 'resourcesPath', { value: '/Applications/Test.app/Contents/Resources' });
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', relative), 'utf8'), {
    module, process: mockProcess, URL,
    require: (name) => modules[name] || (name === 'node:path' ? platform === 'win32' ? path.win32 : path.posix : require(name))
  });
  return module.exports;
}

test('macOS bundled runtimes use executable paths inside the app Resources directory', () => {
  const paths = load('electron/paths.js', 'darwin', {
    electron: { app: { isPackaged: true, getPath: () => '/Users/test/Library/Application Support/web-mcp-assistant' } }
  });
  assert.equal(paths.portablePython(), '/Applications/Test.app/Contents/Resources/resources/native-python/bin/python3');
  assert.equal(paths.tunnelExecutable(), '/Applications/Test.app/Contents/Resources/resources/tools/tunnel-client');
  assert.equal(paths.settingsFile(), '/Users/test/Library/Application Support/web-mcp-assistant/settings.json');
});

test('macOS portable Python launches itself without a pythonw.exe substitution', async () => {
  const executable = '/Applications/Test.app/Contents/Resources/resources/native-python/bin/python3';
  const commands = [];
  const environment = load('electron/services/environmentService.js', 'darwin', {
    'node:fs': { existsSync: (value) => value === executable },
    '../paths': { portablePython: () => executable },
    './commandRunner': { run: async (command) => { commands.push(command); return { code: 0, stdout: 'Python 3.12.10', stderr: '' }; } },
    './proxyService': {}
  });
  const result = await environment.pythonStatus({ force: true });
  assert.equal(result.command, executable);
  assert.equal(result.launchCommand, executable);
  assert.deepEqual(commands, [executable]);
});

test('macOS reads enabled HTTP proxies from scutil without invoking Windows tools', async () => {
  const commands = [];
  const proxy = load('electron/services/proxyService.js', 'darwin', {
    './commandRunner': { run: async (command, args) => {
      commands.push([command, ...args]);
      return { code: 0, stdout: '<dictionary> {\n HTTPEnable : 0\n HTTPProxy : disabled.test\n HTTPPort : 1234\n HTTPSEnable : 1\n HTTPSProxy : 127.0.0.1\n HTTPSPort : 7897\n}' };
    } }
  });
  assert.deepEqual(Array.from(await proxy.systemProxyCandidates()), ['http://127.0.0.1:7897']);
  assert.deepEqual(commands, [['/usr/sbin/scutil', '--proxy']]);
});
