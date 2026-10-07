'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('Mac 安装包必须在 ARM64 macOS 构建机生成。');
}
for (const relative of ['native-python/bin/python3', 'tools/tunnel-client', 'tools/rg', 'tools/fd']) {
  fs.accessSync(path.join(root, 'resources/mac-arm64', relative), fs.constants.X_OK);
}
const cli = require.resolve('electron-builder/out/cli/cli.js');
const result = spawnSync(process.execPath, [cli, '--mac', '--arm64', '--config', 'electron-builder.mac.json', '--publish', 'never'], {
  cwd: root, stdio: 'inherit', env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' }
});
if (result.error) throw result.error;
process.exitCode = result.status || 0;
