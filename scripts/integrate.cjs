const fs = require('node:fs');
const path = require('node:path');
const target = process.argv[2];
if (!target) throw new Error('Uso: node scripts/integrate.cjs caminho/extrator-vendas/index.html');
const file = path.resolve(target);
let html = fs.readFileSync(file, 'utf8');
if (!html.includes('</body>')) throw new Error('HTML sem fechamento de body. Nenhuma alteração.');
if (!html.includes('/assets/negan.js')) {
  html = html.replace('</body>', '  <script src="/assets/negan.js" defer></script>\n</body>');
  fs.writeFileSync(file, html);
}
console.log('Negan integrado em ' + file);
