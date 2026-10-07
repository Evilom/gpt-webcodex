const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const jsonStore = require('../electron/services/jsonStore');

function fixture(t, platform = process.platform) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-start-stop-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const statePath = path.join(root, 'runtime-state.json');
  const active = new Set();
  const launches = [];
  const kills = [];
  const modules = {
    '../paths': { tunnelExecutable: () => process.execPath, tunnelLogFile: () => path.join(root, 'tunnel.log'), stateFile: () => statePath },
    './jsonStore': jsonStore,
    './logService': { rotateLog() {} },
    './environmentService': { canConnect: async () => true },
    './proxyService': { probeDirect: async () => true, probeHttpProxy: async () => true },
    './nativeService': { isAlive: (pid) => active.has(pid) },
    './commandRunner': {
      async run(command, args) {
        assert.equal(command, 'taskkill.exe');
        const pid = Number(args[1]);
        kills.push(pid);
        active.delete(pid);
      }
    },
    'node:child_process': {
      spawn(executable, args, options) {
        const pid = 42000 + launches.length;
        launches.push({ executable, args, options, pid });
        active.add(pid);
        return { pid, unref() {} };
      }
    }
  };
  const module = { exports: {} };
  const source = fs.readFileSync(path.join(__dirname, '../electron/services/tunnelService.js'), 'utf8');
  const mockProcess = Object.create(process);
  Object.defineProperty(mockProcess, 'platform', { value: platform });
  mockProcess.kill = (pid) => { kills.push(Math.abs(pid)); active.delete(Math.abs(pid)); };
  vm.runInNewContext(source, { module, process: mockProcess, setTimeout, require: (name) => modules[name] || require(name) });
  const service = () => new module.exports.TunnelService({ info() {}, warn() {} });
  return { service, launches, kills, active, state: () => jsonStore.readJson(statePath) };
}

for (const platform of ['win32', 'darwin']) for (const scenario of [
  { name: 'effective proxy overrides configured proxy', settings: { effectiveProxyUrl: 'http://127.0.0.1:7897', proxyUrl: 'http://127.0.0.1:9999' }, proxy: 'http://127.0.0.1:7897' },
  { name: 'explicit direct route overrides configured proxy', settings: { effectiveProxyUrl: '', proxyUrl: 'http://127.0.0.1:9999' }, proxy: '' },
  { name: 'configured proxy is used when no effective route is supplied', settings: { proxyUrl: 'http://127.0.0.1:7897' }, proxy: 'http://127.0.0.1:7897' }
]) {
  test(`Tunnel start persists PID and stop finds it (${platform}): ${scenario.name}`, async (t) => {
    const f = fixture(t, platform);
    await f.service().start({ tunnelId: 'fixture-tunnel', healthPort: 18081, mcpPort: 18765, ...scenario.settings }, 'fixture-key', 'fixture-token', () => {});
    const launch = f.launches[0];
    assert.equal(f.state().tunnelPid, launch.pid);
    assert.equal(f.state().tunnelProxyUrl, scenario.proxy);
    assert.equal(f.state().tunnelRouteMode, scenario.proxy ? 'proxy' : 'direct');
    const proxyIndex = launch.args.indexOf('--control-plane.http-proxy');
    assert.equal(proxyIndex >= 0, Boolean(scenario.proxy));
    if (proxyIndex >= 0) assert.equal(launch.args[proxyIndex + 1], scenario.proxy);
    assert.equal(launch.options.windowsHide, true);
    assert.equal(launch.options.detached, platform !== 'win32');
    assert.equal(await f.service().stop(), true);
    assert.deepEqual(f.kills, [launch.pid]);
    assert.equal(f.active.size, 0);
    assert.equal(f.state().tunnelPid, null);
    assert.equal(f.state().tunnelProxyUrl, '');
    assert.equal(f.state().tunnelRouteMode, '');
  });
}
