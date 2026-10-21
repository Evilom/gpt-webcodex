// Runs only in the native page of a tab whose goal the user enabled.
function inspectGoalPage(options = {}) {
  const text = node => String(['TEXTAREA', 'INPUT'].includes(node?.tagName) ? node.value : node?.innerText ?? node?.textContent ?? '').trim();
  const visible = node => {
    if (!node) return false;
    const style = getComputedStyle(node), rect = node.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
  };
  const isStop = node => /^(stop|stop generating|stop generating response|停止|停止生成|停止生成回复)$/i.test(node.getAttribute('aria-label') || '')
    || /^(stop-button|stop-generating-button)$/.test(node.dataset.testid || '');
  if (!window.__thinktankGoalInput) {
    window.__thinktankGoalInput = { stops: 0, editedAt: 0 };
    document.addEventListener('click', event => {
      if (event.isTrusted && isStop(event.target.closest?.('button') || document.createElement('button'))) window.__thinktankGoalInput.stops++;
    }, true);
    document.addEventListener('beforeinput', event => {
      if (event.isTrusted) window.__thinktankGoalInput.editedAt = Date.now();
    }, true);
  }
  const buttons = Array.from(document.querySelectorAll('button')).filter(visible);
  const main = document.querySelector('main');
  const messages = Array.from(main?.querySelectorAll('[data-message-author-role]') || []);
  const lastUser = messages.filter(node => node.dataset.messageAuthorRole === 'user').at(-1);
  const approval = buttons.some(node => /^(允许|始终允许|批准|allow|always allow|approve)/i.test(text(node)))
    || Array.from(document.querySelectorAll('[role="dialog"],dialog[open]')).some(visible);
  const composer = Array.from(document.querySelectorAll('#prompt-textarea,textarea[data-id="root"]')).find(visible);
  const form = composer?.closest('form') || composer?.parentElement?.parentElement;
  const attachments = Boolean(form?.querySelector('[data-testid*="attachment" i],[data-testid*="file-thumbnail" i],button[aria-label*="Remove" i],button[aria-label*="移除"],button[aria-label*="删除"]'))
    || Array.from(document.querySelectorAll('input[type="file"]')).some(node => node.files?.length);
  const base = {
    conversationId: location.hostname === 'chatgpt.com' ? location.pathname.match(/(?:^|\/)c\/([^/]+)/)?.[1] || '' : '',
    generating: buttons.some(node => isStop(node) && !node.disabled),
    manualStops: window.__thinktankGoalInput.stops,
    editing: Date.now() - window.__thinktankGoalInput.editedAt < 10000,
    blocked: approval ? '等待你处理网页授权或对话框' : !composer ? '等待网页登录或输入框恢复' : '',
    draft: Boolean(text(composer)), attachments,
    acknowledged: Boolean(options.sendTag && text(lastUser).includes(options.sendTag))
  };
  const turns = Array.from(main?.querySelectorAll('[data-testid^="conversation-turn-"]') || []);
  const latestTurn = turns.at(-1);
  const notices = Array.from(main?.querySelectorAll('[role="alert"],[role="status"],[class*="error" i],[data-testid*="error" i]') || []).slice(-32);
  const error = notices.find(node => {
    const turn = node.closest('[data-testid^="conversation-turn-"]');
    return visible(node) && (!turn || turn === latestTurn) && !node.closest('pre,code,blockquote,[data-message-author-role="user"]')
      && (!lastUser || !(node.compareDocumentPosition(lastUser) & Node.DOCUMENT_POSITION_FOLLOWING))
      && /^(Invalid conversation body|消息流中的错误|消息流出现错误|error in (?:the )?message stream|ChatGPT stream recovery polling timed out|连接已中断|connection interrupted)/i.test(text(node));
  });
  base.error = error ? /^Invalid conversation body/i.test(text(error)) ? 'invalid-conversation-body' : /recovery polling|连接已中断|connection interrupted/i.test(text(error)) ? 'recovery' : 'message-stream' : '';
  // Do not clone or read an answer while it is streaming or the user is editing.
  if (base.generating || base.blocked || base.draft || base.attachments || base.editing) return base;
  const lastAssistant = messages.filter(node => node.dataset.messageAuthorRole === 'assistant').at(-1);
  const reply = (lastAssistant || latestTurn)?.cloneNode(true);
  reply?.querySelectorAll('pre,code,blockquote').forEach(node => node.remove());
  reply?.querySelectorAll('br').forEach(node => node.replaceWith(document.createTextNode('\n')));
  reply?.querySelectorAll('p,div,li,section').forEach(node => node.append('\n'));
  const replyTail = String(reply?.textContent || '').trim().slice(-6000);
  const userCount = messages.filter(node => node.dataset.messageAuthorRole === 'user').length;
  const assistantCount = messages.filter(node => node.dataset.messageAuthorRole === 'assistant').length;
  const lastLine = replyTail.split(/\r?\n/).filter(line => line.trim()).at(-1)?.trim() || '';
  return {
    ...base,
    turnKey: `${userCount}:${lastUser?.dataset.messageId || ''}:${assistantCount}:${lastAssistant?.dataset.messageId || ''}`,
    hasReply: Boolean(lastAssistant && messages.at(-1) === lastAssistant && replyTail),
    done: Boolean(options.goalId && lastLine === `[目标完成:${options.goalId}]`),
    needsUser: Boolean(options.goalId && lastLine === `[需要用户:${options.goalId}]`)
  };
}

async function submitGoalPrompt(options) {
  // Recheck in the same JS turn as insertion; never reuse a stale composer.
  const inspect = options.inspect;
  const normalized = value => String(value || '').replace(/\s+/g, ' ').trim();
  const before = inspect(options);
  if (window.__thinktankGoalSendId !== options.sendId || before.conversationId !== options.conversationId || before.error === 'invalid-conversation-body' || before.generating || before.blocked || before.draft || before.attachments || before.editing || before.manualStops !== options.manualStops) return { sent: false, reason: '网页状态已变化，未发送' };
  const input = document.querySelector('#prompt-textarea') || document.querySelector('textarea[data-id="root"]');
  if (!input) return { sent: false, reason: '输入框不可用' };
  if (input.tagName === 'TEXTAREA') {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, options.text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    input.focus();
    document.execCommand('insertText', false, options.text);
    if (normalized(input.innerText) !== normalized(options.text)) return { uncertain: true, reason: '输入框未确认接收完整消息，请检查草稿' };
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: options.text }));
  }
  await new Promise(resolve => setTimeout(resolve, 350));
  const current = inspect(options);
  if (window.__thinktankGoalSendId !== options.sendId || current.conversationId !== options.conversationId || current.error === 'invalid-conversation-body' || current.generating || current.blocked || current.attachments || current.editing || current.manualStops !== options.manualStops) return { uncertain: true, reason: '填写后网页状态变化，请检查草稿' };
  const value = String(input.value ?? input.innerText ?? '').trim();
  const button = document.querySelector('button[data-testid="send-button"],button[aria-label="发送提示词"],button[aria-label="发送"],button[aria-label="Send prompt"]');
  if (normalized(value) !== normalized(options.text) || !button || button.disabled || button.getAttribute('aria-disabled') === 'true') return { uncertain: true, reason: '发送按钮或草稿发生变化，请手动检查' };
  button.click();
  // A click is not delivery evidence. Only an echoed user turn confirms send.
  for (let index = 0; index < 20; index++) {
    await new Promise(resolve => setTimeout(resolve, 150));
    if (inspect(options).acknowledged) return { sent: true };
  }
  return { uncertain: true, reason: '无法确认网页是否已接收；已暂停，避免重复发送' };
}

function goalDeadline(promise, milliseconds, onTimeout = () => {}) {
  let timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => { onTimeout(); reject(new Error('目标网页状态确认超时')); }, milliseconds); });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

module.exports = { inspectGoalPage, submitGoalPrompt, goalDeadline };
