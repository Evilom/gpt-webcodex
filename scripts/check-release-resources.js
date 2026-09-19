#!/usr/bin/env node
/**
 * Non-destructive release resource gate.
 * Reports missing packaging inputs. Never deletes workspace files.
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const required = [
  'package.json',
  'electron/main.js',
  'electron/browserPreload.js',
  'renderer/index.html',
  'renderer/browser.html',
  'renderer/browser.js',
  'renderer/app.js',
  'resources/coding-tools-mcp/coding_tools_mcp/server.py',
  'resources/coding-tools-mcp/coding_tools_mcp/__init__.py',
  'resources/coding-tools-mcp/pyproject.toml',
  'resources/coding-tools-mcp/schema-contract.json',
  'electron/app-icon.png',
];

// Optional at dev checkout; required only for a shippable portable runtime bundle.
const portableOptionalInDev = [
  'resources/tools/python/python.exe',
];

const warnings = [];
const errors = [];

for (const rel of required) {
  if (!fs.existsSync(path.join(root, rel))) errors.push(`缺少必需文件：${rel}`);
}

for (const rel of portableOptionalInDev) {
  if (!fs.existsSync(path.join(root, rel))) {
    warnings.push(`开发 checkout 可接受缺失：${rel}（发行包必须补齐）`);
  }
}

// Schema contract must match runtime version fields present.
try {
  const contract = JSON.parse(fs.readFileSync(path.join(root, 'resources/coding-tools-mcp/schema-contract.json'), 'utf8'));
  const init = fs.readFileSync(path.join(root, 'resources/coding-tools-mcp/coding_tools_mcp/__init__.py'), 'utf8');
  const versionMatch = init.match(/__version__\s*=\s*"([^"]+)"/);
  const runtimeVersion = versionMatch ? versionMatch[1] : '';
  if (contract.runtime_version !== runtimeVersion) {
    errors.push(`Schema 契约 runtime_version=${contract.runtime_version} 与 __init__.py=${runtimeVersion} 不一致`);
  }
  if (!contract.schema_version || !contract.schema_hash) {
    errors.push('Schema 契约缺少 schema_version/schema_hash');
  }
} catch (error) {
  errors.push(`Schema 契约读取失败：${error.message}`);
}

// package versions should not silently disagree with product display if present.
if (!pkg.version) errors.push('package.json 缺少 version');

const report = {
  ok: errors.length === 0,
  version: pkg.version,
  errors,
  warnings,
  checkedAt: new Date().toISOString(),
};

if (warnings.length) {
  for (const w of warnings) console.warn(`[warn] ${w}`);
}
if (errors.length) {
  for (const e of errors) console.error(`[error] ${e}`);
  console.error('发行资源门禁未通过。不要据此宣称安装包可发布。');
  process.exit(1);
}
console.log(`发行资源门禁通过（开发形态）。桌面版本 ${pkg.version}`);
console.log('注意：本检查不等于干净 Windows 安装验收，也不等于 Tunnel 端到端验收。');
