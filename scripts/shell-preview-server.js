'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const port = Number(process.env.SHELL_PREVIEW_PORT || 48173);
const mockChat = fs.readFileSync(path.join(__dirname, 'fixtures/studio-chat.html'), 'utf8');
function previewHtml(search = new URLSearchParams()) {
  const chatQuery = new URLSearchParams({ theme: search.get('theme') || 'dark', conversation: search.get('conversation') || 'active' });
  if (search.get('scenario') === 'chat-skin' || search.get('independentChat') === '1') chatQuery.set('native','1');
  return fs.readFileSync(path.join(root, 'renderer/browser.html'), 'utf8')
    .replace("style-src 'self'", "style-src 'self' 'unsafe-inline'")
    .replace('</head>', '<link rel="stylesheet" href="/studio-preview-controls.css"></head>')
    .replace('<main class="loading-stage">', '<iframe id="previewChat" title="模拟 ChatGPT 页面" src="/mock-chat.html?' + chatQuery.toString() + '" style="position:fixed;left:0;top:56px;right:0;bottom:36px;width:auto;height:auto;border:0"></iframe><main class="loading-stage" hidden>')
    .replace('<script src="progressPresentation.js">', '<script src="/preview-api.js"></script><script src="progressPresentation.js">');
}
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/mock-chat.html') { res.writeHead(200, { 'Content-Type': types['.html'] }); return res.end(url.searchParams.get('native')==='1'?fs.readFileSync(path.join(__dirname,'fixtures/chat-native.html')):mockChat); }
  if (url.pathname === '/preview-api.js') { res.writeHead(200, { 'Content-Type': types['.js'] }); return res.end(fs.readFileSync(path.join(__dirname, 'shell-preview-api.js'))); }
  if (['/studio-preview.css', '/studio-preview-controls.css', '/studio-preview.js','/chat-native.css','/chat-native.js'].includes(url.pathname)) {
    res.writeHead(200, { 'Content-Type': types[path.extname(url.pathname)] });
    return res.end(fs.readFileSync(path.join(__dirname, 'fixtures', url.pathname.slice(1))));
  }
  if (url.pathname === '/' || url.pathname === '/browser.html') { res.writeHead(200, { 'Content-Type': types['.html'] }); return res.end(previewHtml(url.searchParams)); }
  const renderer = path.join(root, 'renderer');
  const file = path.resolve(renderer, `.${decodeURIComponent(url.pathname)}`);
  if (!file.startsWith(renderer + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
server.listen(port, '127.0.0.1', () => console.log(`Isolated shell preview: http://127.0.0.1:${server.address().port}/`));
