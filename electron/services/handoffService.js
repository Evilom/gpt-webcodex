const path = require('node:path');
const fs = require('node:fs/promises');

const MAX_HANDOFF_BYTES = 256 * 1024;
const HANDOFF_DIR = '.coding-tools';
const HANDOFF_NAME = 'handoff.md';

function extractPath(item) {
  return String(typeof item === 'string' ? item : (item?.path || '')).trim();
}

/**
 * Persist a structured handoff document before any chat injection.
 * Returns the file path so UI can confirm save before claiming "inherited".
 */
async function writeHandoffFile(root, {
  taskState = null,
  gitStatus = '',
  objective = '',
  currentStep = '',
  modifiedFiles = [],
  failedCommands = [],
  unverified = [],
  nextSteps = [],
  evidence = {},
  baselineHead = '',
} = {}) {
  if (!root) throw new Error('未选择工作区，无法写入交接文件。');
  const dir = path.join(root, HANDOFF_DIR);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, HANDOFF_NAME);

  const files = (Array.isArray(modifiedFiles) ? modifiedFiles : [])
    .map(extractPath)
    .filter(Boolean);
  const obj = objective || taskState?.objective || '（未填写目标）';
  const step = currentStep || taskState?.current_step || taskState?.next_step || '（未填写当前步骤）';
  const failure = taskState?.failure || '';

  const lines = [
    '# 任务交接记录',
    '',
    `生成时间：${new Date().toISOString()}`,
    `基线 HEAD：${baselineHead || '（未知）'}`,
    '',
    '## 目标',
    obj,
    '',
    '## 当前步骤',
    step,
    failure ? `\n失败信息：${failure}` : '',
    '',
    '## 已修改文件',
    files.length ? files.map((p) => `- \`${p}\``).join('\n') : '- （无记录）',
    '',
    '## Git 状态',
    '```',
    String(gitStatus || '').trim() || '（无）',
    '```',
    '',
    '## 失败命令',
    failedCommands.length
      ? failedCommands.map((c) => `- ${c}`).join('\n')
      : '- （无）',
    '',
    '## 未验证项',
    unverified.length
      ? unverified.map((c) => `- ${c}`).join('\n')
      : '- （未登记，请接手后确认测试/构建是否跑过）',
    '',
    '## 建议下一步',
    nextSteps.length
      ? nextSteps.map((c) => `- ${c}`).join('\n')
      : `- 先核对本记录与当前工作树是否一致\n- 再决定是继续当前任务还是开新任务`,
    '',
    '## 证据',
    '```json',
    JSON.stringify(evidence || {}, null, 2),
    '```',
    '',
    '> 本文件由桌面助手写入。新会话请先读此文件并核对代码状态，不要仅凭提示词假设任务已完成。',
  ].filter((line) => line !== false && line !== null && line !== undefined);

  const content = lines.join('\n').slice(0, MAX_HANDOFF_BYTES);
  await fs.writeFile(file, content, 'utf8');
  return { path: file, bytes: Buffer.byteLength(content, 'utf8'), content };
}

module.exports = { writeHandoffFile, HANDOFF_DIR, HANDOFF_NAME };
