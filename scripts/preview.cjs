const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const handler = require('../lib/negan.cjs').createHandler();
const root = path.resolve(__dirname, '..');
const types = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png'};
http.createServer(async (req, res) => {
  res.status = n => {res.statusCode = n; return res;};
  res.json = body => {res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body));};
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/negan') {
    let size = 0, chunks = [];
    for await (const chunk of req) { size += chunk.length; if (size > 20000) return res.status(413).json({error:'Mensagem muito longa.'}); chunks.push(chunk); }
    try { req.body = JSON.parse(Buffer.concat(chunks).toString()); } catch { return res.status(400).json({error:'JSON inválido.'}); }
    return handler(req, res);
  }
  if (url.pathname.startsWith('/api/')) return res.status(503).json({error:'Prévia: pagamentos desativados. Nenhuma cobrança foi realizada.'});
  const name = url.pathname === '/' ? 'preview/index.html' : url.pathname.startsWith('/assets/negan.') ? url.pathname.slice(1) : 'preview' + url.pathname;
  const file = path.resolve(root, name);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {res.statusCode=404; return res.end('Não encontrado');}
  res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
}).listen(4173, '127.0.0.1', () => console.log('Prévia local: http://127.0.0.1:4173'));
