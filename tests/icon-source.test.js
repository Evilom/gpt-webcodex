const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');

test('all app icon surfaces use the single generated icon source', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const main = fs.readFileSync(path.join(root, 'electron', 'main.js'), 'utf8');
  assert.equal(pkg.build.win.icon, 'electron/app-icon.ico');
  assert.equal(pkg.build.nsis.installerIcon, 'electron/app-icon.ico');
  assert.equal(pkg.build.nsis.uninstallerIcon, 'electron/app-icon.ico');
  assert.equal(pkg.build.nsis.installerHeaderIcon, 'electron/app-icon.ico');
  assert.equal(pkg.build.nsis.createDesktopShortcut, 'always');
  assert.match(main, /app-icon\.png/);
  assert.doesNotMatch(main, /tray\.png/);
  assert.doesNotMatch(JSON.stringify(pkg), /build\/icon\.png/);
});

test('legacy icon files are not used as build inputs', () => {
  assert.equal(fs.existsSync(path.join(root, 'electron', 'tray.png')), false);
  assert.equal(fs.existsSync(path.join(root, 'build', 'icon.png')), false);
});

test('Windows and Mac ship the same brand master and valid icon containers', () => {
  for (const name of ['app-icon.png', 'app-icon.ico', 'app-icon.icns']) {
    assert.deepEqual(fs.readFileSync(path.join(root, 'electron', name)), fs.readFileSync(path.join(root, 'electron', 'brand', name)));
  }
  const png=fs.readFileSync(path.join(root,'electron','app-icon.png'));
  assert.equal(png.readUInt32BE(16),1024); assert.equal(png.readUInt32BE(20),1024);
  const toolbar=fs.readFileSync(path.join(root,'renderer','brand-icon.png'));
  assert.equal(toolbar.readUInt32BE(16),128); assert.equal(toolbar.readUInt32BE(20),128);
  const ico=fs.readFileSync(path.join(root,'electron','app-icon.ico'));
  assert.equal(ico.readUInt16LE(0),0); assert.equal(ico.readUInt16LE(2),1); assert.ok(ico.readUInt16LE(4)>=6);
  const icns=fs.readFileSync(path.join(root,'electron','app-icon.icns'));
  assert.equal(icns.toString('ascii',0,4),'icns'); assert.equal(icns.readUInt32BE(4),icns.length);
});
