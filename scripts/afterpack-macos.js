'use strict';

// The ad-hoc seal approach follows Chat On Steroids' macOS afterPack hook:
// https://github.com/totec448-spec/chat-on-steroids/blob/main/scripts/afterpack-macos-adhoc-seal.mjs
const path = require('node:path');
const { spawnSync } = require('node:child_process');

module.exports = async (context) => {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  for (const args of [
    ['--force', '--deep', '--sign', '-', app],
    ['--verify', '--deep', '--strict', '--verbose=2', app]
  ]) {
    const result = spawnSync('/usr/bin/codesign', args, { encoding: 'utf8' });
    if (result.error || result.status !== 0) throw new Error(result.stderr || result.error?.message || 'Mac 临时签名校验失败');
  }
  console.log('[macos] 临时签名与资源封装校验通过（未进行开发者签名或公证）');
};
