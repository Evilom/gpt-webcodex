const { randomUUID } = require('node:crypto');
const { readJson, writeJsonAtomic } = require('./jsonStore');

const ERROR_LIMIT = 3;
const runningOperation = item => !['completed', 'failed', 'cancelled', 'interrupted'].includes(String(item?.status || ''));

function localWorkIsIdle({ health, task, operations } = {}) {
  if (health?.ready !== true || health.active_commands !== 0 || Number(health.starting_commands || 0) !== 0) return false;
  if (!Array.isArray(operations) || operations.some(runningOperation)) return false;
  if (['paused', 'waiting_user', 'waiting_approval', 'needs_user'].includes(task?.lifecycle_state) || task?.status === 'paused') return false;
  const command = task?.current_command;
  return !command || ['completed', 'failed', 'cancelled', 'interrupted'].includes(String(command.status || command.execution_lifecycle_state || ''));
}

function goalPrompt(goal, reason, tag) {
  return `${tag}\n目标：${goal.objective}\n${reason === 'error' ? '上一轮网页消息流异常。' : '请核对目标是否已全部完成。'}先只读核对当前工作目录、已落盘成果与验证记录，保留已经完成的部分，不要重复执行、覆盖成果或等待旧请求；只推进目标范围内尚未完成的步骤。单次本地工作流完成不等于整个目标完成。\n只有完成全部目标并给出可核对的交付与验证结果后，才在回复最后单独写一行 [目标完成:${goal.id}]。如果需要用户授权、缺少关键条件或无法继续，说明原因并在最后单独写 [需要用户:${goal.id}]。不得替用户批准网页权限，不要自动重放发布、删除等后果不明确的操作。`;
}

class GoalModeService {
  constructor({ file, controllers, workspace, localState, connectionReady, onChange = () => {}, log = {}, now = () => Date.now() }) {
    Object.assign(this, { file, controllers, workspace, localState, connectionReady, onChange, log, now });
    this.goals = new Map();
    this.candidates = new Map();
    this.busy = false;
    this.disposed = false;
    const saved = readJson(file, { goals: [] }).goals;
    for (const goal of Array.isArray(saved) ? saved.slice(-50) : []) {
      if (!goal?.conversationId || !goal.id || typeof goal.objective !== 'string') continue;
      this.goals.set(goal.conversationId, { ...goal, status: goal.status === 'running' ? 'paused' : goal.status, reason: goal.status === 'running' ? '软件已重新打开，请核对原会话后恢复' : goal.reason });
    }
  }

  stateFor(key) {
    const goal = this.goals.get(key);
    if (!goal) return null;
    const { id, objective, status, reason, rounds, maxRounds, errors, updatedAt } = goal;
    return { id, objective, status, reason, rounds, maxRounds, errors, updatedAt };
  }

  change(goal, patch) {
    if (Object.entries(patch).every(([key, value]) => goal[key] === value)) return;
    Object.assign(goal, patch, { updatedAt: this.now() });
    if (patch.status && patch.status !== 'running') this.controllers().find(item => item.streamConversationId() === goal.conversationId)?.cancelGoalSend?.();
    writeJsonAtomic(this.file, { goals: [...this.goals.values()].slice(-50) });
    this.onChange();
  }

  async start(controller, options = {}) {
    const objective = String(options.objective || '').trim();
    if (!objective || objective.length > 4000) throw new Error('请填写目标，最多 4000 字。');
    const workspace = this.workspace();
    const page = await controller.inspectGoalPage();
    if (!workspace || workspace !== this.workspace()) throw new Error('工作区已变化，请核对后重新开启目标。');
    if (!page.conversationId) throw new Error('请先打开一个具体的 ChatGPT 会话。');
    const previous = this.goals.get(page.conversationId);
    if (previous && ['running', 'paused'].includes(previous.status)) throw new Error('这个会话已有目标，请先恢复或结束原目标。');
    const goal = {
      id: randomUUID(), conversationId: page.conversationId, objective,
      workspace, status: 'running', reason: '', rounds: 0, errors: 0,
      maxRounds: Math.max(1, Math.min(50, Math.floor(Number(options.maxRounds) || 10))),
      manualStops: page.manualStops, documentId: page.documentId, sendTag: '', awaitingReply: false
    };
    this.goals.set(goal.conversationId, goal);
    controller.armGoal?.(goal.id);
    this.change(goal, { reason: '目标已开启，等待当前回复结束后核对' });
    return this.stateFor(goal.conversationId);
  }

  pause(key, reason = '已手动暂停；不会继续发送消息') {
    const goal = this.goals.get(key);
    if (goal?.status === 'running') this.change(goal, { status: 'paused', reason });
    return this.stateFor(key);
  }

  pauseAll(reason) { for (const key of this.goals.keys()) this.pause(key, reason); }

  stop(key) {
    const goal = this.goals.get(key);
    if (goal) this.change(goal, { status: 'stopped', reason: '目标已结束，已有任务和成果保留' });
    return this.stateFor(key);
  }

  async resume(controller) {
    const page = await controller.inspectGoalPage(), goal = this.goals.get(page.conversationId);
    if (!goal || goal.workspace !== this.workspace()) throw new Error('请回到目标原来的会话和工作区。');
    if (goal.pendingSend && !page.acknowledged) {
      // The last send may have reached ChatGPT even if its echo was not observed.
      const receipt = await controller.inspectGoalPage({ goalId: goal.id, sendTag: goal.sendTag });
      if (!receipt.acknowledged) throw new Error('上次发送结果尚不可确认，请先检查原会话和草稿，避免重复执行。');
    }
    this.candidates.delete(goal.id);
    controller.armGoal?.(goal.id);
    this.change(goal, { status: 'running', reason: '目标已恢复', awaitingReply: goal.awaitingReply || Boolean(goal.pendingSend), manualStops: page.manualStops, documentId: page.documentId, pendingSend: false, errors: 0, maxRounds: Math.max(goal.maxRounds, goal.rounds + 1) });
    return this.stateFor(goal.conversationId);
  }

  async tick() {
    if (this.busy || this.disposed || ![...this.goals.values()].some(goal => goal.status === 'running')) return;
    this.busy = true;
    try {
      const controllers = this.controllers();
      for (const goal of this.goals.values()) {
        if (goal.status !== 'running') continue;
        const controller = controllers.find(item => item.streamConversationId() === goal.conversationId);
        if (!controller || goal.workspace !== this.workspace()) { this.pause(goal.conversationId, '会话已关闭、切换或工作区已变化，请核对后恢复'); continue; }
        let page;
        try { page = await controller.inspectGoalPage({ goalId: goal.id, sendTag: goal.sendTag }); }
        catch { this.candidates.delete(goal.id); this.change(goal, { reason: '这个标签的网页状态不可确认，暂不接续' }); continue; }
        if (goal.status !== 'running' || this.disposed) continue;
        if (page.conversationId !== goal.conversationId || page.documentId !== goal.documentId) { this.pause(goal.conversationId, '网页已导航或重新加载，请核对后恢复'); continue; }
        if (page.manualStops !== goal.manualStops) { this.pause(goal.conversationId, '你已停止生成，目标模式已暂停'); continue; }
        if (page.error === 'invalid-conversation-body') { this.pause(goal.conversationId, 'ChatGPT 提示对话请求内容无效，请先检查原会话；不会自动重试或续发'); continue; }
        if (page.blocked || page.draft || page.attachments || page.editing) {
          this.candidates.delete(goal.id);
          this.change(goal, { reason: page.blocked || '保留你的草稿、附件或输入，等待你处理' }); continue;
        }
        if (goal.awaitingReply && !page.acknowledged) { this.pause(goal.conversationId, '检测到其他新消息，请确认是否继续此目标'); continue; }
        if (page.generating || controller.loading || !page.error && controller.streamState.status !== 'healthy') {
          this.candidates.delete(goal.id);
          this.change(goal, { reason: 'ChatGPT 仍在处理，保持当前回复运行' }); continue;
        }
        if (!page.error && goal.awaitingReply && page.hasReply && page.done) {
          this.change(goal, { status: 'completed', reason: '模型报告目标已完成；交付与验证结果保留在原会话' }); continue;
        }
        if (!page.error && goal.awaitingReply && page.hasReply && page.needsUser) { this.pause(goal.conversationId, '模型需要用户处理，请查看原会话'); continue; }
        if (!page.error && goal.awaitingReply && !page.hasReply) { this.change(goal, { reason: '等待当前消息的完整回复' }); continue; }
        const reason = page.error ? 'error' : 'review';
        if (goal.rounds >= goal.maxRounds || reason === 'error' && goal.errors >= ERROR_LIMIT) { this.pause(goal.conversationId, '已达到自动接续上限，请检查原会话后决定是否恢复'); continue; }
        const key = `${page.turnKey}:${reason}`;
        let candidate = this.candidates.get(goal.id);
        if (!candidate || candidate.key !== key) { candidate = { key, since: this.now() }; this.candidates.set(goal.id, candidate); }
        const delay = reason === 'error' ? 15000 * (2 ** goal.errors) : 5000;
        if (this.now() - candidate.since < delay) { this.change(goal, { reason: reason === 'error' ? '消息流异常，等待恢复并核对本地执行' : '当前回复已结束，正在核对目标' }); continue; }
        if (!localWorkIsIdle(await this.localState()) || !await this.connectionReady()) { this.change(goal, { reason: '等待本地执行结束及 MCP / Tunnel 连接恢复' }); continue; }
        if (goal.status !== 'running' || this.disposed || goal.workspace !== this.workspace()) continue;
        const sendTag = `[目标模式 ${goal.id}/${goal.rounds + 1}]`;
        // Persist intent before touching the page. An unknown outcome is never replayed.
        this.change(goal, { pendingSend: true, sendTag, rounds: goal.rounds + 1, errors: reason === 'error' ? goal.errors + 1 : 0, reason: '正在发送目标核对与续接消息' });
        let receipt;
        try { receipt = await controller.submitGoalPrompt({ goalId: goal.id, conversationId: goal.conversationId, documentId: goal.documentId, manualStops: goal.manualStops, sendTag, text: goalPrompt(goal, reason, sendTag) }); }
        catch { receipt = { uncertain: true, reason: '发送结果不可确认，已暂停以避免重复执行' }; }
        this.candidates.delete(goal.id);
        if (receipt.sent) this.change(goal, { pendingSend: false, awaitingReply: true, reason: '已发送续接消息，等待 ChatGPT 核对已有成果' });
        else this.change(goal, { status: 'paused', pendingSend: Boolean(receipt.uncertain), reason: receipt.reason || '网页状态变化，未发送' });
        this.log.info?.('目标模式续接结果', { goalId: goal.id, round: goal.rounds, trigger: reason, sent: Boolean(receipt.sent), uncertain: Boolean(receipt.uncertain) });
        break; // At most one tab sends per scheduler tick.
      }
    } catch (error) {
      this.log.warn?.('目标模式等待状态确认', { error: error.message });
    } finally { this.busy = false; }
  }

  dispose() { this.disposed = true; for (const controller of this.controllers()) controller.cancelGoalSend?.(); }
}

module.exports = { GoalModeService, goalPrompt, localWorkIsIdle };
