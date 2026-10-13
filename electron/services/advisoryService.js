'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { readJson, writeJsonAtomic } = require('./jsonStore');

class AdvisoryService {
  constructor({ directory, secrets, fetchImpl = globalThis.fetch }) {
    this.file = path.join(directory, 'extensions.json');
    this.secrets = secrets;
    this.fetch = fetchImpl;
    this.models = [];
    this.submitting = false;
  }
  configuration() {
    const saved = readJson(this.file, {});
    let config = { base_url: saved.baseUrl, api_key: this.secrets.get('taijiAssistKey') };
    if (!config.api_key) {
      try { config = JSON.parse(fs.readFileSync(process.env.TAIJI_ASSIST_CONFIG || path.join(os.homedir(), '.config', 'taiji-assist', 'client.json'), 'utf8')); } catch {}
    }
    return { saved, base: config.base_url || '', key: config.api_key || '' };
  }
  status() {
    const { saved, base, key } = this.configuration();
    return { configured: Boolean(base && key), baseUrl: base, selected: saved.selected || [], models: this.models, job: saved.job || null };
  }
  importConfiguration(config) {
    const current = readJson(this.file, {});
    if (current.job && !['completed', 'partial', 'failed', 'interrupted'].includes(current.job.status)) throw new Error('请先查询原辅助任务，再更换服务配置。');
    const base = this.validateBase(config.base_url);
    const key = String(config.api_key || '').trim();
    if (!key || /[\r\n]/.test(key)) throw new Error('客户端配置缺少有效密钥。');
    this.secrets.set('taijiAssistKey', key);
    const saved = readJson(this.file, {});
    writeJsonAtomic(this.file, { ...saved, baseUrl: base, selected: [] });
    this.models = [];
    return this.status();
  }
  validateBase(value) {
    let url;
    try { url = new URL(String(value || '')); } catch { throw new Error('服务地址无效。'); }
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) throw new Error('远端服务需要 HTTPS；本机回环地址可使用 HTTP。');
    return url.href.replace(/\/$/, '');
  }
  async request(method, suffix, body) {
    const { base, key } = this.configuration();
    if (!key) throw new Error('请先导入太极辅助服务的客户端配置。');
    const response = await this.fetch(`${this.validateBase(base)}/v1/assist${suffix}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    if (!response.ok) throw new Error(`辅助服务返回 HTTP ${response.status}。请检查服务或客户端权限。`);
    return response.json();
  }
  async catalog() {
    const result = await this.request('GET', '/models');
    this.models = (Array.isArray(result.models) ? result.models : []).filter((item) => /^(anthropic|google)::/.test(item.id || '') && !/image|video/i.test(item.id || '')).map((item) => ({ id: String(item.id), name: String(item.name || item.id) }));
    return this.status();
  }
  select(ids) {
    if (!Array.isArray(ids) || ids.length > 3 || ids.some((id) => !this.models.some((model) => model.id === id))) throw new Error('最多选择三个服务目录中实际存在的模型。');
    const saved = readJson(this.file, {});
    writeJsonAtomic(this.file, { ...saved, selected: [...new Set(ids)] });
    return this.status();
  }
  async submit(question) {
    const { saved } = this.configuration();
    if (this.submitting || saved.job && !['completed', 'partial', 'failed', 'interrupted'].includes(saved.job.status)) throw new Error('已有辅助咨询正在进行或提交结果待确认，请先查询原任务。');
    const text = String(question || '').trim();
    if (!text || text.length > 8000) throw new Error('请填写咨询问题，最多 8000 字。');
    if (!saved.selected?.length) throw new Error('请先勾选辅助模型。');
    await this.catalog();
    if (saved.selected.length > 3 || saved.selected.some((id) => !this.models.some((model) => model.id === id))) throw new Error('所选模型已不在服务目录中，请重新选择。');
    const requestId = crypto.randomUUID();
    this.submitting = true;
    writeJsonAtomic(this.file, { ...saved, job: { id: requestId, request_id: requestId, status: 'submitting', models: saved.selected } });
    try {
      const result = await this.request('POST', '/jobs', { request_id: requestId, task: 'second_opinion', question: text, context: [], constraints: ['以中文回答，仅提供建议，不声称已执行本地操作。'], models: saved.selected, max_output_tokens: 1800 });
      if (!result.id) throw new Error('服务没有返回任务 ID，请查询原请求后再处理。');
      writeJsonAtomic(this.file, { ...readJson(this.file, {}), job: { id: result.id, request_id: requestId, status: result.status || 'queued', models: saved.selected } });
      return result;
    } finally { this.submitting = false; }
  }
  async result() {
    const { saved } = this.configuration();
    const id = String(saved.job?.id || '');
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(id)) throw new Error('没有可查询的辅助任务。');
    const result = await this.request('GET', `/jobs/${encodeURIComponent(id)}`);
    writeJsonAtomic(this.file, { ...readJson(this.file, {}), job: { ...saved.job, status: result.status || saved.job.status } });
    return result;
  }
}
module.exports = { AdvisoryService };
