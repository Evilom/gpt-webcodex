const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('workspace bar and task strip do not overflow with flex shrink rules', () => {
  const css = read('renderer/browser.css');
  // Fixed toolbar height must stay 112px.
  assert.match(css, /\.browser-toolbar\{[^}]*height:112px/);
  // Workspace bar items shrink instead of deforming the row.
  assert.match(css, /\.workspace-bar\{[^}]*overflow:visible/);
  assert.match(css, /\.task-strip\{[^}]*min-width:0/);
  assert.match(css, /\.task-strip\{[^}]*overflow:hidden/);
  // Console drawer is height-clamped to viewport.
  assert.match(css, /\.task-console-drawer\{[^}]*height:min\(320px,48vh\)/);
  assert.match(css, /\.task-console-drawer\[hidden\]\{display:none!important\}/);
  // History popover sits above drawer layer and is not clipped by strip.
  assert.match(css, /\.task-history-popover\{[^}]*z-index:110/);
  // No duplicate competing task-history-popover rule with old z-index 88.
  const historyRules = css.match(/\.task-history-popover\{/g) || [];
  assert.equal(historyRules.length, 1);
});

test('opening console closes hanging popovers and re-measures insets after paint', () => {
  const js = read('renderer/browser.js');
  assert.match(js, /function closeHangOverlays/);
  assert.match(js, /function hangOverlaysOpen/);
  assert.match(js, /closeHangOverlays\(\)/);
  assert.match(js, /requestAnimationFrame\(\(\) => \{[\s\S]{0,40}requestAnimationFrame\(syncChatContentInsets\)/);
  // Inset clamp prevents chat view collapse on short windows.
  assert.match(js, /Math\.min\(rect\.height \|\| 320, window\.innerHeight \* 0\.55\)/);
  // History toggle also closes other hang overlays.
  assert.match(js, /closeHangOverlays\('#taskHistoryPopover'\)/);
});

test('console header wraps instead of crushing action buttons', () => {
  const css = read('renderer/browser.css');
  assert.match(css, /\.console-header\{[^}]*flex-wrap:wrap/);
  assert.match(css, /\.console-actions\{[^}]*flex-wrap:wrap/);
  assert.match(css, /\.console-git-commit-bar\{[^}]*flex-wrap:wrap/);
});
