'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const port = Number(process.env.SHELL_PREVIEW_PORT || 48173);
const mockChat = `<!doctype html><html lang="zh-CN" data-theme="dark"><meta charset="UTF-8"><link rel="stylesheet" href="/scrollbars.css"><style>*{box-sizing:border-box}body{margin:0;background:#000;color:#eee;font:14px/1.8 'Segoe UI','Microsoft YaHei UI',sans-serif;display:flex;height:100vh}nav{width:230px;flex-shrink:0;padding:24px;border-right:1px solid #222}nav b{font-size:20px}nav p{margin:22px 0;color:#b4b4b4}.selected{padding:10px;background:#212121;border-radius:8px;color:#fff}main{position:relative;flex:1;min-width:0;padding:24px 30px 110px;overflow:auto}header{font-size:18px}.conversation{max-width:780px;margin:36px auto 0}.question{margin-left:80px;padding:16px 20px;background:#212121;border-radius:18px}h2{font-size:22px;margin-top:32px}h3{font-size:17px}.attachment{display:inline-block;padding:10px 16px;border:1px solid #333;border-radius:10px;color:#ddd}.composer{position:fixed;bottom:24px;left:calc(230px + 30px);right:30px;border-radius:24px;padding:16px 20px;background:#212121;color:#888}.caption{font-size:11px;color:#888;margin-top:24px}@media(max-width:760px){nav{display:none}.composer{left:24px}.question{margin-left:0}main{padding:20px 24px 110px}}</style><nav><b>ChatGPT</b><p>新建对话</p><p>搜索对话</p><p>探索 GPT</p><small>最近</small><p class="selected">研究方案设计讨论</p><p>代码实现思路</p><p>数据清洗方法比较</p><p>相关论文整理</p></nav><main><header>ChatGPT</header><div class="conversation"><p class="question">我正在撰写一篇关于大语言模型在软件工程中应用的研究论文，请帮我设计一个完整、可执行的研究方案。</p><p>好的，我将为你设计研究方案，力求结构完整，并紧贴实际研究条件。</p><h2>1. 研究背景与目标</h2><h3>1.1 研究背景</h3><p>近年来，大语言模型在代码生成、代码理解、自动化测试和文档生成等软件工程任务中展现出潜力。本研究将通过可重复的实验方法，系统评估不同模型的实际效果。</p><h3>1.2 研究目标</h3><ul><li>系统评估模型在典型任务中的表现</li><li>分析任务类型、模型选择和提示方法之间的关系</li><li>形成可验证、可复用的实践建议</li></ul><div class="attachment">研究方案初稿.docx · 28 KB</div><p class="caption">这是隔离预览中的模拟聊天内容；正式应用承载原生 ChatGPT 页面。</p></div><div class="composer">发送消息…</div></main></html>`;
function previewHtml() {
  return fs.readFileSync(path.join(root, 'renderer/browser.html'), 'utf8')
    .replace("style-src 'self'", "style-src 'self' 'unsafe-inline'")
    .replace('<main class="loading-stage">', '<iframe id="previewChat" title="模拟 ChatGPT 页面" src="/mock-chat.html" style="position:fixed;left:0;top:56px;right:0;bottom:36px;width:auto;height:auto;border:0"></iframe><main class="loading-stage" hidden>')
    .replace('<script src="progressPresentation.js">', '<script src="/preview-api.js"></script><script src="progressPresentation.js">');
}
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/mock-chat.html') { res.writeHead(200, { 'Content-Type': types['.html'] }); return res.end(mockChat); }
  if (url.pathname === '/preview-api.js') { res.writeHead(200, { 'Content-Type': types['.js'] }); return res.end(fs.readFileSync(path.join(__dirname, 'shell-preview-api.js'))); }
  if (url.pathname === '/' || url.pathname === '/browser.html') { res.writeHead(200, { 'Content-Type': types['.html'] }); return res.end(previewHtml()); }
  const renderer = path.join(root, 'renderer');
  const file = path.resolve(renderer, `.${decodeURIComponent(url.pathname)}`);
  if (!file.startsWith(renderer + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
server.listen(port, '127.0.0.1', () => console.log(`Isolated shell preview: http://127.0.0.1:${server.address().port}/`));
