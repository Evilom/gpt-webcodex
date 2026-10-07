'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const asar = require('@electron/asar');
const { LocalMcpClient } = require('../electron/services/localMcpClient');
const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const app = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'dist/mac-arm64', `${pkg.build.productName}.app`);
const resources = path.join(app, 'Contents/Resources/resources');
const python = path.join(resources, 'native-python/bin/python3');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'web-mcp-mac-package-'));
const children = new Set();
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function launch(executable, args, options = {}) {
  const child = spawn(executable, args, { detached: true, stdio: 'ignore', ...options });
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  for (let attempt = 0; attempt < 30 && child.exitCode === null && child.signalCode === null; attempt++) await wait(100);
  if (child.exitCode === null && child.signalCode === null) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    await wait(200);
  }
  assert.ok(child.exitCode !== null || child.signalCode !== null, 'Owned process did not exit');
}
async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function main() {
  assert.equal(process.platform, 'darwin');
  assert.equal(process.arch, 'arm64');
  const seal = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { encoding: 'utf8' });
  assert.equal(seal.status, 0, seal.stderr);
  const plist = JSON.parse(spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(app, 'Contents/Info.plist')], { encoding: 'utf8' }).stdout);
  assert.equal(plist.CFBundleIdentifier, pkg.build.appId);
  assert.equal(plist.CFBundleShortVersionString, pkg.version);
  assert.equal(plist.LSMinimumSystemVersion, '13.0');
  const packed = asar.listPackage(path.join(app, 'Contents/Resources/app.asar'));
  assert.ok(packed.some((entry) => entry.endsWith('/electron/main.js')));
  assert.ok(packed.some((entry) => entry.endsWith('/renderer/react-dist/manager-react.js')));
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(target);
      else assert.ok(!/\.(exe|dll|pyd|pyc)$/i.test(entry.name), `Foreign or cached runtime: ${target}`);
    }
  };
  walk(resources);
  for (const executable of [python, ...['tunnel-client', 'rg', 'fd'].map((name) => path.join(resources, 'tools', name))]) {
    const result = spawnSync(executable, ['--version'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const architecture = spawnSync('/usr/bin/lipo', ['-archs', fs.realpathSync(executable)], { encoding: 'utf8' });
    assert.equal(architecture.status, 0, architecture.stderr);
    assert.equal(architecture.stdout.trim(), 'arm64');
  }
  const workspace = path.join(temporary, '工作区');
  fs.mkdirSync(workspace);
  const port = await unusedPort();
  const token = 'macos-package-smoke-fixture-only';
  const client = new LocalMcpClient({ port, token });
  let previousIdentity;
  for (let iteration = 0; iteration < 2; iteration++) {
    const child = launch(python, ['-m', 'coding_tools_mcp', '--workspace', workspace, '--host', '127.0.0.1', '--port', String(port), '--permission-mode', 'dangerous'], {
      env: {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: '1',
        PYTHONPATH: [path.join(resources, 'coding-tools-mcp/python_vendor'), path.join(resources, 'coding-tools-mcp')].join(':'),
        CODING_TOOLS_MCP_MEMORY_ROOT: path.join(temporary, 'memory'),
        CODING_TOOLS_MCP_AUTH_MODE: 'bearer', CODING_TOOLS_MCP_AUTH_TOKEN: token,
        CODING_TOOLS_MCP_TOOL_MODE: 'smart', CODING_TOOLS_MCP_TELEMETRY: 'off',
        CODING_TOOLS_MCP_LAUNCH_ID: `macos-smoke-${iteration}`
      }
    });
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      try { await client.discoverTools(); ready = true; break; } catch { await wait(100); }
    }
    assert.ok(ready, 'Packaged Python MCP did not start');
    const identity = client.schemaIdentity();
    assert.equal(identity.version, pkg.version);
    assert.equal(identity.processId, child.pid);
    assert.equal(identity.workspace, workspace);
    assert.equal(identity.toolCount, 10);
    if (previousIdentity) assert.notEqual(identity.runtimeInstanceId, previousIdentity.runtimeInstanceId);
    const result = await client.callTool('exec_command', { cmd: 'printf mac-mini-ok', yield_time_ms: 1000 });
    assert.notEqual(result.isError, true);
    assert.ok(JSON.stringify(result).includes('mac-mini-ok'));
    previousIdentity = identity;
    await stop(child);
  }
  const profile = path.join(temporary, 'profile');
  const desktop = launch(path.join(app, 'Contents/MacOS', pkg.build.productName), [`--user-data-dir=${profile}`]);
  let started = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { started = fs.readFileSync(path.join(profile, 'logs/assistant.log'), 'utf8').includes('网页 MCP 助手已启动'); } catch {}
    if (started) break;
    await wait(200);
  }
  assert.ok(started, 'Packaged Electron app did not finish startup');
  await stop(desktop);
  console.log('[macos-package] PASS: ARM64 app, portable tools, command, same-port restart and desktop startup');
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => {
  for (const child of Array.from(children)) await stop(child).catch(() => {});
  fs.rmSync(temporary, { recursive: true, force: true });
});
