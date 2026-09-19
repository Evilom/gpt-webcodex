const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { run } = require('./commandRunner');
const paths = require('../paths');
const { resolveProxy } = require('./proxyService');

async function commandExists(name) {
  const result = await run('where.exe', [name], { allowFailure: true });
  return result.code === 0;
}

function canConnect(host, port, timeout = 800) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(timeout);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

let cachedPythonStatus = null;
let cachedPythonStatusTime = 0;
const PYTHON_CACHE_TTL = 30_000;

async function checkCandidate(candidate) {
  const result = await run(candidate.command, [...candidate.args, '--version'], { allowFailure: true });
  const output = `${result.stdout} ${result.stderr}`.trim();
  const match = output.match(/Python\s+(\d+)\.(\d+)\.(\d+)/i);
  const major = match ? Number(match[1]) : 0;
  const minor = match ? Number(match[2]) : 0;
  if (result.code === 0 && match && (major > 3 || (major === 3 && minor >= 11))) {
    return { installed: true, command: candidate.command, launchCommand: candidate.launchCommand, prefixArgs: candidate.args, version: match[0] };
  }
  return null;
}

async function pythonStatus(options = {}) {
  if (!options?.force && cachedPythonStatus && Date.now() - cachedPythonStatusTime < PYTHON_CACHE_TTL) {
    return cachedPythonStatus;
  }
  if (fs.existsSync(paths.portablePython())) {
    const pythonw = pathForPythonw(paths.portablePython());
    const candidate = { command: paths.portablePython(), launchCommand: fs.existsSync(pythonw) ? pythonw : paths.portablePython(), args: [] };
    const valid = await checkCandidate(candidate);
    if (valid) {
      cachedPythonStatus = valid;
      cachedPythonStatusTime = Date.now();
      return valid;
    }
  }
  const resolved = await resolveSystemPython();
  if (resolved) {
    const valid = await checkCandidate(resolved);
    if (valid) {
      cachedPythonStatus = valid;
      cachedPythonStatusTime = Date.now();
      return valid;
    }
  }
  const notFound = { installed: false, command: '', launchCommand: '', prefixArgs: [], version: '' };
  cachedPythonStatus = notFound;
  cachedPythonStatusTime = Date.now();
  return notFound;
}

function pathForPythonw(pythonPath) {
  return path.join(path.dirname(pythonPath), 'pythonw.exe');
}

// pyw.exe/py.exe 只是启动器，spawn 记录的 PID 与 MCP health 返回的 os.getpid()
// 往往不是同一个进程，会导致部署身份检查失败。这里解析出真正的解释器再启动。
async function resolveSystemPython() {
  if (await commandExists('py.exe')) {
    const probe = await run('py.exe', ['-3', '-c', 'import sys; print(sys.executable)'], { allowFailure: true });
    const exe = String(probe.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop();
    if (exe && fs.existsSync(exe)) {
      const pythonw = pathForPythonw(exe);
      return { command: exe, launchCommand: fs.existsSync(pythonw) ? pythonw : exe, args: [] };
    }
  }
  if (await commandExists('python.exe')) {
    const where = await run('where.exe', ['python.exe'], { allowFailure: true });
    const exe = String(where.stdout || '').trim().split(/\r?\n/).map((line) => line.trim()).find((line) => line && fs.existsSync(line));
    if (exe) {
      const pythonw = pathForPythonw(exe);
      return { command: exe, launchCommand: fs.existsSync(pythonw) ? pythonw : exe, args: [] };
    }
  }
  return null;
}

class EnvironmentService {
  async inspect(settings, options = {}) {
    const force = options.force === true || options.forceProxy === true;
    const [python, proxy, mcpListening, tunnelListening] = await Promise.all([
      pythonStatus({ force }),
      resolveProxy(settings, { force: options.forceProxy === true }).catch(() => ({ mode: settings.proxyMode, resolvedUrl: '', source: 'error', reachable: false })),
      canConnect('127.0.0.1', settings.mcpPort),
      canConnect('127.0.0.1', settings.healthPort)
    ]);
    return {
      platform: process.platform,
      python,
      proxy: {
        mode: proxy.mode,
        configured: Boolean(proxy.resolvedUrl),
        reachable: proxy.reachable,
        url: proxy.resolvedUrl,
        source: proxy.source
      },
      tunnelClient: { installed: fs.existsSync(paths.tunnelExecutable()), path: paths.tunnelExecutable() },
      workspace: { configured: Boolean(settings.workspace), exists: Boolean(settings.workspace && fs.existsSync(settings.workspace)) },
      ports: { mcpListening, tunnelListening },
      nativePortableReady: fs.existsSync(paths.portablePython())
    };
  }

}

module.exports = { EnvironmentService, commandExists, canConnect, pythonStatus };
