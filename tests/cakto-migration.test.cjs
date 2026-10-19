const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
test('legacy MP purchase endpoints never create charges even if the old flag is enabled',async()=>{
 const saved=global.fetch;global.fetch=()=>{throw Error('provider must not be called');};
 const old=process.env.MERCADOPAGO_CHECKOUT_ENABLED;process.env.MERCADOPAGO_CHECKOUT_ENABLED='true';
 try{for(const name of ['create-mercadopago-checkout','create-mercadopago-payment'])for(const plan of ['initial','professional','advanced','https://evil.example']){
 let status,payload;const res={setHeader(){},status(n){status=n;return this},json(v){payload=v;return this}};
 await require('../api/'+name+'.js')({method:'POST',body:{plan}},res);
 assert.equal(status,410);assert.equal(payload.provider,'cakto');assert.equal(payload.url,'https://app.vinitech.dev.br/comprar?plano='+(['initial','professional','advanced'].includes(plan)?plan:'professional'));
 }}finally{global.fetch=saved;if(old===undefined)delete process.env.MERCADOPAGO_CHECKOUT_ENABLED;else process.env.MERCADOPAGO_CHECKOUT_ENABLED=old;}
});
test('each public plan keeps its identity in the app purchase link',()=>{
 const html=fs.readFileSync('extrator-vendas/index.html','utf8');assert.doesNotMatch(html,/mercadopago|Mercado Pago/);
 const nodes=new Map();const buttons=['initial','professional','advanced'].map(plan=>({dataset:{plan},classList:{toggle(){}},setAttribute(){},addEventListener(_,fn){this.click=fn}}));
 const document={querySelector(s){if(!nodes.has(s))nodes.set(s,{scrollIntoView(){}});return nodes.get(s)},querySelectorAll(){return buttons}};
 vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1],{document,Date});
 for(const button of buttons){button.click();assert.equal(nodes.get('#checkout').href,'https://app.vinitech.dev.br/comprar?plano='+button.dataset.plan);}
});
