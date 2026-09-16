const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createHandler, guided, validateMessages, retrySeconds} = require('../lib/negan.cjs');
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

test('fallback do vídeo responde à profissão sem trocar por TI',()=>{
  const list=[...messages('Como funciona?'),{role:'assistant',content:'Você pode pesquisar empresas. Quantas pesquisas pretende fazer?'},...messages('sou tecnico de ar condicionado isso funciona para mim ?')];
  const r=guided(list);
  assert.match(r.reply,/ar-condicionado/); assert.match(r.reply,/clínicas, lojas e escritórios/);
  assert.doesNotMatch(r.reply,/quem oferece TI|comparar os planos/); assert.equal(r.plan,null);
  list.push({role:'assistant',content:r.reply},...messages('Atendo em São Paulo'));
  const region=guided(list); assert.match(region.reply,/ar-condicionado/); assert.match(region.reply,/Qual desses tipos/);
  list.push({role:'assistant',content:region.reply},...messages('Clínicas'));
  assert.match(guided(list).reply,/quantas pesquisas por mês/);
});
test('fallback usa apenas profissão do visitante e aceita mudança',()=>{
  assert.doesNotMatch(guided([...messages('oi'),{role:'assistant',content:'Por exemplo, ar-condicionado'},...messages('Como funciona?')]).reply,/ar-condicionado/);
  const r=guided([...messages('Sou técnico de ar condicionado'),{role:'assistant',content:'Onde atende?'},...messages('Na verdade trabalho com marketing. Funciona?')]);
  assert.match(r.reply,/marketing/); assert.doesNotMatch(r.reply,/ar-condicionado/);
});
test('formato estrito exige resposta e histórico completo chega ao modelo',async()=>{
  const list=[...messages('Sou técnico de ar condicionado'),{role:'assistant',content:'Onde atende?'},...messages('São Paulo')];
  let calls=0;
  const r=await run({body:{messages:list},config:env,fetcher:async(url,opts)=>{
    if(++calls===1) return {ok:true,json:async()=>({result:1})};
    const body=JSON.parse(opts.body); assert.deepEqual(body.messages.slice(1),list);
    assert.equal(body.response_format.type,'json_schema'); assert.equal(body.response_format.json_schema.strict,true);
    assert.deepEqual(body.response_format.json_schema.schema.required,['reply','plan','handoff']);
    return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({reply:'Você pode avaliar clínicas em São Paulo.',plan:null,handoff:false})}}]})};
  }}); assert.equal(r.data.mode,'ai'); assert.equal(calls,2);
});
test('objeto vazio preserva profissão sem repetir chamadas pagas',async()=>{
  for(const response of [{ok:true,json:async()=>({choices:[{message:{content:'{}'}}]})},{ok:true,json:async()=>({choices:[{message:{content:'null'}}]})}]) {
    let calls=0; const r=await run({config:env,body:{messages:messages('Sou técnico de ar condicionado, funciona para mim?')},fetcher:async()=>++calls===1?{ok:true,json:async()=>({result:1})}:response});
    assert.equal(r.data.mode,'guided'); assert.match(r.data.reply,/ar-condicionado/); assert.equal(calls,2);
  }
});
test('diagnóstico não contém conversa nem credenciais',async()=>{
  const events=[]; let calls=0;
  const req={method:'POST',headers:{origin:'https://vinitech.dev.br','content-type':'application/json'},body:{messages:messages('texto privado')}};
  const res={setHeader(){},status(){return this;},json(){return this;}};
  await createHandler(env,async()=>++calls===1?{ok:true,json:async()=>({result:1})}:{ok:false,status:429},e=>events.push(e))(req,res);
  assert.deepEqual(events,[{event:'negan_rate_limited',status:429,retryAfter:60}]);
});

test('limite do provedor orienta espera sem substituir conversa por resposta guiada',async()=>{
  for(const [header,expected] of [['25',25],[null,60],['inválido',60],['0',1],['180',180]]) {
    let calls=0;
    const r=await run({config:env,fetcher:async()=>++calls===1?{ok:true,json:async()=>({result:1})}:{ok:false,status:429,headers:{get:()=>header}}});
    assert.equal(r.code,429); assert.equal(r.data.code,'ai_rate_limited');
    assert.equal(r.data.retryAfter,expected); assert.equal(r.headers['Retry-After'],String(expected));
    assert.equal(r.data.reply,undefined); assert.equal(r.data.mode,undefined); assert.equal(calls,2);
  }
});
test('Retry-After aceita segundos e data sem abreviar prazo do provedor',()=>{
  const now=Date.parse('2026-09-16T16:00:00Z');
  assert.equal(retrySeconds('Wed, 16 Sep 2026 16:01:10 GMT',now),70);
  assert.equal(retrySeconds('2.5',now),3); assert.equal(retrySeconds('',now),60);
});
test('quarta até oitava pergunta seguem para IA com histórico',async()=>{
  const list=[];
  for(let turn=1;turn<=8;turn++) {
    list.push({role:'user',content:turn===1?'Sou técnico de ar-condicionado em São Paulo':`Pergunta ${turn}`});
    let calls=0;
    const r=await run({config:env,body:{messages:list},fetcher:async(url,opts)=>{
      if(++calls===1)return {ok:true,json:async()=>({result:turn})};
      assert.deepEqual(JSON.parse(opts.body).messages.slice(1),list);
      return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({reply:`Resposta ${turn}`,plan:null,handoff:false})}}]})};
    }});
    assert.equal(r.data.mode,'ai'); list.push({role:'assistant',content:r.data.reply});
  }
});
