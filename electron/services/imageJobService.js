'use strict';
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { readJson, writeJsonAtomic } = require('./jsonStore');
const execute = promisify(execFile);
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,79}$/;
const TERMINAL = new Set(['succeeded', 'failed', 'interrupted']);
const SIZES = ['1024x1024', '1536x1024', '1024x1536', 'auto'];
const requestDigest = (prompt, size, model = 'gpt-image-2') => crypto.createHash('sha256').update(JSON.stringify({ prompt, size, model })).digest('hex');

// Reuse the user's detached CLIProxy runner. The desktop never owns its workers
// or account credentials, so closing a window cannot cancel generation.
class ImageJobService {
  constructor({ directory, run = execute }) {
    this.file = path.join(directory, 'image-jobs.json');
    this.requests = path.join(directory, 'image-requests');
    this.run = run;
    this.submissions = new Map();
    this.listing = null;
  }
  status() {
    const saved = readJson(this.file, {});
    const configured = Boolean(saved.runner && saved.python);
    return { configured, enabled: configured && saved.enabled === true, model: 'gpt-image-2',
      base_url: saved.baseUrl || '', runner: saved.runner || '',
      last_request_id: Object.keys(saved.requests || {}).at(-1) || '',
      limits: { max_prompt_bytes: 24000, sizes: SIZES, images_per_job: 1, poll_after_seconds: 15 },
      message: '由 AI 提交后继续主任务；后台串行出图。生成成功仅表示文件落盘，仍需查看预览审核。' };
  }
  async importConfiguration(config) {
    if (config.name !== 'local-cliproxy-material-jobs' || config.version !== 1
        || config.proxy_base_url !== 'http://127.0.0.1:8317/v1') throw new Error('请选择 CLIProxy 异步入口的 integration.json。');
    for (const value of [config.job_runner, config.python]) {
      if (typeof value !== 'string' || !path.isAbsolute(value) || !(await fsp.stat(value)).isFile()) throw new Error('本机 Python 或任务入口不存在，请先部署 CLIProxy 异步入口。');
    }
    const current = readJson(this.file, {});
    if (current.runner && (current.runner !== config.job_runner || current.python !== config.python)) {
      const pending = await this.list();
      if (this.submissions.size || pending.active_count || pending.unconfirmed_count) throw new Error('后台仍有生图任务或提交待确认，请完成后再更换入口。');
    }
    writeJsonAtomic(this.file, { ...current, runner: config.job_runner, python: config.python, baseUrl: config.proxy_base_url, enabled: false });
    return this.status();
  }
  select(enabled) {
    if (typeof enabled !== 'boolean' || !this.status().configured) throw new Error('请先导入本机异步生图入口。');
    writeJsonAtomic(this.file, { ...readJson(this.file, {}), enabled });
    return this.status();
  }
  async command(args) {
    const config = readJson(this.file, {});
    if (!config.runner || !config.python) throw new Error('异步生图入口未配置；继续主任务。');
    let output;
    try {
      output = await this.run(config.python, ['-B', config.runner, ...args], {
        windowsHide: true, shell: false, timeout: 7000, maxBuffer: 2 * 1024 * 1024,
        encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }
      });
    } catch { throw new Error('本机异步入口未确认；保留原任务编号，不自动重新提交。'); }
    const result = JSON.parse(output.stdout.replace(/^\uFEFF/, '').trim());
    if (result?.status === 'error') throw new Error(String(result.error || '任务入口操作失败').slice(0, 300));
    return result;
  }
  present(job, verifyRequest = false) {
    const config = readJson(this.file, {});
    const record = Object.hasOwn(config.requests || {}, job.id) ? config.requests[job.id] : null;
    if (verifyRequest && record) {
      const request = readJson(path.join(path.dirname(config.runner), 'jobs', job.id, 'request.json'), null);
      if (!request) job = { id: job.id, kind: 'image', status: 'submission_unknown', error: '原请求内容尚未确认；保留编号，不自动重发。' };
      else if (request.kind !== 'image' || requestDigest(request.prompt, request.size, request.model) !== record.digest) {
        job = { id: job.id, kind: 'image', status: 'failed', error: '原编号对应不同的提示词或尺寸；本轮不会使用该旧任务的图片，也不会自动重新生成。' };
      }
    }
    const result = { id: job.id, title: record?.title || job.id, status: job.status, kind: job.kind,
      created_at: job.created_at || record?.created_at, started_at: job.started_at, finished_at: job.finished_at,
      error: job.error, model: job.requested_model || 'gpt-image-2', dimensions: job.dimensions,
      sha256: job.sha256, review_status: job.status === 'succeeded' ? (['passed', 'rejected'].includes(job.review_status) ? job.review_status : 'pending') : undefined,
      poll_after_seconds: 15, can_continue_main_task: true };
    if (job.status === 'succeeded' && job.kind === 'image') {
      const root = path.join(path.dirname(readJson(this.file, {}).runner), 'jobs', job.id);
      result.file = path.join(root, 'image.png');
      result.preview = path.join(root, 'preview.jpg');
    }
    return result;
  }
  async list(limit = 30, options = {}) {
    if (!this.status().configured) return { ...this.status(), jobs: [], total: 0, active_count: 0 };
    if (!this.listing) this.listing = this.command(['status']).finally(() => { this.listing = null; });
    const all = await this.listing;
    if (!Array.isArray(all)) throw new Error('异步入口返回的任务列表无效。');
    const images = all.filter(job => job.kind === 'image' && typeof job.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(job.id));
    for (const [id, record] of Object.entries(readJson(this.file, {}).requests || {})) {
      if (!images.some(job => job.id === id)) images.push({ id, kind: 'image', status: 'submission_unknown', created_at: record.created_at, error: '原任务尚未确认，请查询原编号，不要重新提交。' });
    }
    const presented = images.map(job => this.present(job, true));
    const active = presented.filter(job => ['queued', 'running'].includes(job.status));
    const unconfirmed = presented.filter(job => job.status === 'submission_unknown');
    const sorted = presented.sort((a, b) => Number(!TERMINAL.has(b.status)) - Number(!TERMINAL.has(a.status)) || String(b.created_at).localeCompare(String(a.created_at)));
    // Desktop paging does not change the compact public MCP list contract.
    const filter = options?.filter;
    const filtered = sorted.filter(job => filter === 'active' ? !TERMINAL.has(job.status) : filter === 'history' ? TERMINAL.has(job.status) : true);
    const pageSize = Math.max(1, Math.min(50, limit));
    const requested = Number.isSafeInteger(options?.offset) ? Math.max(0, options.offset) : 0;
    const offset = Math.min(requested, Math.max(0, Math.ceil(filtered.length / pageSize) - 1) * pageSize);
    return { ...this.status(), jobs: filtered.slice(offset, offset + pageSize), total: images.length, active_count: active.length, unconfirmed_count: unconfirmed.length,
      filtered_total: filtered.length, offset, selected_job: options?.selected_id ? presented.find(job => job.id === options.selected_id) || null : undefined };
  }
  async submit(args) {
    if (!this.status().enabled) throw new Error('异步生图未启用；在扩展辅助中勾选后 AI 才能提交。');
    const id = args.request_id;
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
    const size = args.size || '1536x1024';
    const title = args.title || 'AI 生图';
    if (!ID.test(id || '') || !prompt || Buffer.byteLength(prompt) > 24000 || !SIZES.includes(size)
        || typeof title !== 'string' || Array.from(title).length > 120) throw new Error('需要稳定的 8–80 位任务编号、最多 24000 UTF-8 字节的提示词和有效尺寸；不会截断输入。');
    const digest = requestDigest(prompt, size);
    const saved = readJson(this.file, {});
    if (Object.hasOwn(saved.requests || {}, id)) {
      if (saved.requests[id].digest !== digest) throw new Error('相同任务编号不能用于不同提示词或尺寸。');
      const result = this.submissions.has(id) ? await this.submissions.get(id) : await this.result(id);
      return { ...result, deduplicated: true };
    }
    // Persist before spawning: even an ambiguous timeout must never replay a POST.
    writeJsonAtomic(this.file, { ...saved, requests: { ...saved.requests, [id]: { digest, title, created_at: new Date().toISOString() } } });
    const submission = this.startSubmission(id, prompt, size).finally(() => this.submissions.delete(id));
    this.submissions.set(id, submission);
    return submission;
  }
  async startSubmission(id, prompt, size) {
    try {
      await fsp.mkdir(this.requests, { recursive: true });
      const promptFile = path.join(this.requests, `${id}.txt`);
      await fsp.writeFile(promptFile, prompt, { encoding: 'utf8', mode: 0o600 });
      const job = await this.command(['submit', '--kind', 'image', '--model', 'gpt-image-2', '--id', id, '--size', size, '--prompt-file', promptFile]);
      if (job.id !== id) throw new Error('任务入口未确认原编号。');
      return this.present({ ...job, kind: 'image', status: job.status === 'submitted' ? 'queued' : job.status });
    } catch {
      return this.present({ id, kind: 'image', status: 'submission_unknown', error: '提交状态待确认；请查询原编号，不要重新提交。' });
    }
  }
  async result(id) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id || '')) throw new Error('需要原生图任务编号。');
    try {
      const job = await this.command(['status', id]);
      if (job.id !== id || job.kind !== 'image') throw new Error('不是有效的生图任务。');
      return this.present(job, true);
    } catch (error) {
      if (!Object.hasOwn(readJson(this.file, {}).requests || {}, id)) throw error;
      return this.present({ id, kind: 'image', status: 'submission_unknown', error: '原任务暂时无法确认；保留编号，不自动重试。' });
    }
  }
  async assetPath(id, preview = false) {
    return this.resolveAsset(await this.result(id), preview);
  }
  async resolveAsset(job, preview) {
    if (job.status !== 'succeeded' || !job.file) throw new Error('图片尚未生成完成。');
    const root = await fsp.realpath(path.join(path.dirname(readJson(this.file, {}).runner), 'jobs'));
    const target = await fsp.realpath(preview ? job.preview : job.file);
    const relative = path.relative(root, target);
    if (relative !== path.join(job.id, preview ? 'preview.jpg' : 'image.png')) throw new Error('资产路径不在原任务目录内。');
    const stat = await fsp.stat(target);
    if (!stat.isFile() || stat.size > (preview ? 200000 : 64 * 1024 * 1024)) throw new Error('资产大小超出查看预算。');
    return target;
  }
  async preview(id) {
    const job = await this.result(id);
    const target = await this.resolveAsset(job, true);
    const bytes = await fsp.readFile(target);
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('预览不是有效的 JPEG 文件。');
    return { id, mime_type: 'image/jpeg', data: bytes.toString('base64'), review_status: job.review_status };
  }
  async agentCall(args) {
    if (!args.action || args.action === 'status') return this.status();
    if (args.action === 'submit') return this.submit(args);
    if (args.action === 'result') return this.result(args.job_id || args.request_id);
    if (args.action === 'list') return this.list(args.limit || 10);
    if (args.action === 'preview') {
      const image = await this.preview(args.job_id || args.request_id);
      return { id: image.id, mime_type: image.mime_type, review_status: image.review_status, _mcp_image_data: image.data };
    }
    throw new Error('生图工具支持 status、submit、result、list、preview。');
  }
}
module.exports = { ImageJobService };
