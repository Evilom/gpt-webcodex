const crypto = require('node:crypto');
const path = require('node:path');

/**
 * One-shot approvals bind a single dangerous action to a scope/task with expiry.
 * Stored in-memory on the process; renderer must request then consume.
 */
class ApprovalStore {
  constructor(options = {}) {
    this.ttlMs = Number(options.ttlMs || 5 * 60 * 1000);
    this.maxItems = Number(options.maxItems || 64);
    this.items = new Map();
  }

  issue({ action, scopeRoot = '', taskId = '', reason = '', grantedBy = 'user' } = {}) {
    const id = crypto.randomBytes(16).toString('hex');
    const now = Date.now();
    const record = {
      id,
      action: String(action || ''),
      scopeRoot: path.resolve(String(scopeRoot || '')),
      taskId: String(taskId || ''),
      reason: String(reason || ''),
      grantedBy: String(grantedBy || 'user'),
      createdAt: now,
      expiresAt: now + this.ttlMs,
      used: false,
    };
    this.items.set(id, record);
    this.prune();
    if (this.items.size > this.maxItems) {
      const oldest = this.items.keys().next().value;
      this.items.delete(oldest);
    }
    return record;
  }

  consume(id, { action = '', scopeRoot = '', taskId = '' } = {}) {
    this.prune();
    const record = this.items.get(String(id || ''));
    if (!record) return { ok: false, error: '授权不存在或已过期，请重新申请。' };
    if (record.used) return { ok: false, error: '该一次性授权已被使用。' };
    if (Date.now() > record.expiresAt) {
      this.items.delete(record.id);
      return { ok: false, error: '授权已过期，请重新申请。' };
    }
    if (action && record.action !== action) {
      return { ok: false, error: `授权动作不匹配：期望 ${record.action}，实际 ${action}` };
    }
    if (scopeRoot && path.resolve(String(scopeRoot)) !== record.scopeRoot) {
      return { ok: false, error: '授权范围与当前工作区不一致。' };
    }
    if (taskId && record.taskId && String(taskId) !== record.taskId) {
      return { ok: false, error: '授权任务与当前任务不一致。' };
    }
    record.used = true;
    this.items.delete(record.id);
    return { ok: true, record };
  }

  peek(id) {
    this.prune();
    const record = this.items.get(String(id || ''));
    if (!record) return null;
    return { ...record };
  }

  prune() {
    const now = Date.now();
    for (const [id, record] of this.items) {
      if (record.used || now > record.expiresAt) this.items.delete(id);
    }
  }

  clear() {
    this.items.clear();
  }
}

module.exports = { ApprovalStore };
