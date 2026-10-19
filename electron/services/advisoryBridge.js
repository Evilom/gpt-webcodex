'use strict';
const http = require('node:http');
const crypto = require('node:crypto');

class AdvisoryBridge {
  constructor({ service, imageService, secrets, port = 18769 }) { this.service = service; this.imageService = imageService; this.secrets = secrets; this.port = port; this.server = null; }
  address() { return this.server ? `http://127.0.0.1:${this.server.address().port}/advisory` : ''; }
  async start() {
    if (this.server) return this.address();
    const server = http.createServer(async (request, response) => {
      const send = (status, body) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(body)); };
      const expected = Buffer.from(`Bearer ${this.secrets.get('mcpAuthToken') || ''}`);
      const supplied = Buffer.from(request.headers.authorization || '');
      if (!this.secrets.get('mcpAuthToken') || supplied.length !== expected.length || !crypto.timingSafeEqual(expected, supplied)) return send(401, { error: '本地辅助接口认证失败。' });
      const service = request.url === '/advisory' ? this.service : request.url === '/image-jobs' ? this.imageService : null;
      if (request.method !== 'POST' || !service || request.headers.origin) return send(403, { error: '辅助接口只供本地 MCP 调用。' });
      try {
        const chunks = []; let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 65536) { send(413, { error: '辅助材料超过本地输入预算，请缩减材料。' }); return; }
          chunks.push(chunk);
        }
        const args = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const result = await service.agentCall(args);
        send(200, result);
      } catch (error) { send(400, { ok: false, error: error.message, job: service.status().job }); }
    });
    server.headersTimeout = 10000;
    server.requestTimeout = 10000;
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(this.port, '127.0.0.1', resolve); });
    this.server = server;
    return this.address();
  }
  async stop() {
    if (!this.server) return;
    const server = this.server; this.server = null;
    server.closeIdleConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
module.exports = { AdvisoryBridge };
