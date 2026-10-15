const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('renderer/theme-bootstrap.js', 'utf8');

function bootstrap(query, dark = false) {
  const body = { dataset: {} }, html = { dataset: {} };
  let onSystemChange, onThemeChange;
  const media = { matches: dark, addEventListener: (_event, listener) => { onSystemChange = listener; } };
  vm.runInNewContext(source, { URLSearchParams, location: { search: query }, document: { body, documentElement: html },
    window: { matchMedia: () => media, activityDetail: { onThemeChanged: (listener) => { onThemeChange = listener; } } } });
  return { body, html, switch: onThemeChange, system(value) { media.matches = value; onSystemChange(); } };
}

test('open auxiliary windows switch theme without reloading their content', () => {
  const page = bootstrap('?theme=dark');
  assert.equal(page.body.dataset.theme, 'dark');
  page.switch('light');
  assert.equal(page.body.dataset.theme, 'light');
  assert.equal(page.html.dataset.theme, 'light');
  page.system(true);
  assert.equal(page.body.dataset.theme, 'light', 'explicit selection must ignore system changes');
});

test('system theme changes continue after switching mode through IPC', () => {
  const page = bootstrap('?theme=light');
  page.switch('system'); page.system(true);
  assert.equal(page.body.dataset.theme, 'dark');
  assert.equal(page.html.dataset.themeMode, 'system');
  page.system(false);
  assert.equal(page.body.dataset.theme, 'light');
  page.switch('dark'); page.system(false);
  assert.equal(page.body.dataset.theme, 'dark');
});

test('pure black retains dark controls and its own palette across live and system changes', () => {
  const { normalize, DEFAULTS } = require('../electron/services/config');
  const settings = normalize({ ...DEFAULTS, theme: 'black' });
  assert.equal(normalize(JSON.parse(JSON.stringify(settings))).theme, 'black');
  const page = bootstrap('?theme=' + settings.theme);
  for (const node of [page.body, page.html]) {
    assert.equal(node.dataset.theme, 'dark');
    assert.equal(node.dataset.themeMode, 'black');
  }
  page.system(false);
  assert.equal(page.body.dataset.themeMode, 'black');
  page.switch('light');
  assert.equal(page.html.dataset.themeMode, 'light');
  page.switch('black'); page.system(true);
  assert.equal(page.body.dataset.themeMode, 'black');
  page.switch('system'); page.system(false);
  assert.equal(page.body.dataset.theme, 'light');
  assert.equal(page.html.dataset.themeMode, 'system');
});
