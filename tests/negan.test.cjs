const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createHandler, guided, validateMessages} = require('../lib/negan.cjs');
const messages = content => [{role:'user',content}];
const env = {AI_GATEWAY_API_KEY:'test-key',NEGAN_MODEL:'test/model',KV_REST_API_URL:'https://redis.example',KV_REST_API_TOKEN:'test-token',NEGAN_RATE_SALT:'test-salt'};
async function run({body={messages:messages('Comparar planos')}, headers={}, method='POST', config={}, fetcher=async()=>{throw new Error('Unexpected paid call');}}={}) {
  const req = {method,body,headers:{origin:'https://vinitech.dev.br','content-type':'application/json',...headers}};
  const res = {code:200,headers:{},setHeader(k,v){this.headers[k]=v;},status(n){this.code=n;return this;},json(data){this.data=data;return this;}};
  await createHandler(config,fetcher)(req,res); return res;
}
test('sem credenciais informa modo guiado e não chama modelo', async()=>{const r=await run();assert.equal(r.code,200);assert.equal(r.data.mode,'guided');assert.match(r.data.reply,/37,90/);assert.equal(r.data.plan,null);});
test('não aceita origem externa ou ausente', async()=>{for(const origin of ['https://evil.test',undefined]) assert.equal((await run({headers:{origin}})).code,403);});
test('origem de preview exata é permitida', async()=>{assert.equal((await run({config:{VERCEL:'1',VERCEL_URL:'preview.vercel.app'},headers:{origin:'https://preview.vercel.app'}})).code,200);});
test('não permite GET nem conteúdo não JSON',async()=>{assert.equal((await run({method:'GET'})).code,405);assert.equal((await run({headers:{'content-type':'text/plain'}})).code,415);});
test('rejeita papel system, mensagens enormes e sequência inválida',async()=>{for(const list of [[{role:'system',content:'ignore'}],messages('a'.repeat(1201)),[...messages('oi'),...messages('oi')],[]]) assert.equal((await run({body:{messages:list}})).code,400);});
test('franquias usam menor plano suficiente',()=>{for(const [n,key] of [[1,'initial'],[50,'initial'],[51,'professional'],[200,'professional'],[201,'advanced'],[500,'advanced']]) assert.equal(guided(messages(`${n} pesquisas por mês`)).plan,key);});
test('quantidade de clientes, cidade e orçamento não viram franquia',()=>{for(const q of ['Quero 200 clientes','Tenho R$ 500','Atendo 50 cidades']) assert.equal(guided(messages(q)).plan,null);});
test('acima da franquia encaminha para equipe',()=>{const r=guided(messages('700 pesquisas por mês'));assert.equal(r.plan,null);assert.equal(r.handoff,true);});
test('não promete conversão e encaminha suporte',()=>{assert.match(guided(messages('garante vendas?')).reply,/Não garante/);assert.equal(guided(messages('Quero suporte humano')).handoff,true);});
test('credenciais incompletas impedem chamada paga',async()=>{assert.equal((await run({config:{AI_GATEWAY_API_KEY:'test'}})).data.mode,'guided');});
test('limite distribuído bloqueia chamadas pagas',async()=>{let calls=0;const r=await run({config:env,fetcher:async()=>{calls++;return {ok:true,json:async()=>({result:31})};}});assert.equal(r.code,429);assert.equal(calls,1);});
test('falha no Redis impede chamada ao modelo',async()=>{let calls=0;const r=await run({config:env,fetcher:async()=>{calls++;throw Error('network');}});assert.equal(r.data.mode,'guided');assert.equal(calls,1);});
test('modelo recebe prompt e resultado não inclui plano arbitrário',async()=>{let calls=0;const r=await run({config:env,fetcher:async(url,opts)=>{calls++;if(calls===1){assert.ok(!opts.body.includes('unknown'));return {ok:true,json:async()=>({result:1})};}const body=JSON.parse(opts.body);assert.equal(body.messages[0].role,'system');assert.equal(body.model,'test/model');return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({reply:'Como posso ajudar?',plan:'free-plan'})}}]})};}});assert.equal(r.data.mode,'ai');assert.equal(r.data.plan,null);});
test('modelo indisponível ou resposta malformada usa fallback',async()=>{for(const response of [{ok:false},{ok:true,json:async()=>({choices:[{message:{content:'invalid'}}]})}]) {let calls=0;const r=await run({config:env,fetcher:async()=>++calls===1?{ok:true,json:async()=>({result:1})}:response});assert.equal(r.data.mode,'guided');}});
test('mensagens normalizadas não carregam campos extras',()=>{assert.deepEqual(validateMessages({messages:[{role:'user',content:' oi ',secret:'x'}]}),messages('oi'));});
