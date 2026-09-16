const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const manifest = require('./original-hashes.json');
test('pagamentos, rotas e mídia são idênticos aos originais recuperados',()=>{
  for(const [file,hash] of Object.entries(manifest)) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex'),hash,file);
});
test('Negan está integrado uma vez nas duas páginas',()=>{
 for(const file of ['index.html','extrator-vendas/index.html']) assert.equal(fs.readFileSync(path.join(root,file),'utf8').split('/assets/negan.js').length-1,1);
});
test('rotas do checkout continuam apontando aos arquivos existentes',()=>{
 const config = JSON.parse(fs.readFileSync(path.join(root,'vercel.json')));
 for(const rewrite of config.rewrites) assert.ok(fs.existsSync(path.join(root,rewrite.destination)),rewrite.destination);
 assert.deepEqual(config.crons,[{path:'/api/mercadopago-runner/',schedule:'0 6 * * *'}]);
});
test('endpoints financeiros rejeitam métodos inválidos sem chamar provedor',async()=>{
 const saved=global.fetch; global.fetch=()=>{throw Error('Não deveria acessar provedor');};
 try {
  for(const name of ['create-mercadopago-checkout','create-mercadopago-payment','mercadopago-webhook']) {
   let status;const res={status(n){status=n;return this;},json(){return this;},setHeader(){}};
   await require('../api/'+name+'.js')({method:'GET',headers:{}},res);assert.equal(status,405,name);
  }
 } finally {global.fetch=saved;}
});
