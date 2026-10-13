'use strict';
const fs = require('node:fs');
const path = require('node:path');
const directory = path.resolve(__dirname, '..', 'electron');
// Checked-in assets keep both platforms identical without build-time image tools.
for (const name of ['app-icon.png', 'app-icon.ico', 'app-icon.icns']) {
  const source = path.join(directory, 'brand', name);
  if (!fs.statSync(source).size) throw new Error(`品牌图标为空：${name}`);
  fs.copyFileSync(source, path.join(directory, name));
}
console.log('已准备超级智囊团 Windows / macOS 图标。');
