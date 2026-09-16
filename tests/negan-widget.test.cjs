const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../assets/negan.js'), 'utf8');
const answer = reply => ({status: 200, data: {mode: 'ai', reply, plan: null}});
const limited = retryAfter => ({status: 429, data: {code: 'ai_rate_limited', error: 'A IA continua ocupada. Tente novamente mais tarde.', ...(retryAfter === undefined ? {} : {retryAfter})}});
const drain = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

// Execute the shipped widget with a small DOM and virtual clock, including its
// real submit/reset handlers, fetch bodies, abort signals and rendered messages.
function widget(responses) {
  let now = 0, timerId = 0;
  const timers = new Map(), calls = [];
  class Element {
    constructor() { this.children = []; this.listeners = {}; this.hidden = false; this.value = ''; this.textContent = ''; }
    append(...items) { this.children.push(...items); }
    replaceChildren(...items) { this.children = items; }
    addEventListener(type, callback) { this.listeners[type] = callback; }
    setAttribute() {}
    focus() {}
    attachShadow() { return root; }
  }
  const selectors = ['.panel', '.launcher', 'textarea', '.messages', '.status', '.suggestions', '.plan-slot', '.send', '.close', '.restart', 'form'];
  const elements = Object.fromEntries(selectors.map(key => [key, new Element()]));
  elements['.panel'].hidden = true;
  const root = new Element(); root.querySelector = key => elements[key];
  const document = {
    getElementById: () => null,
    currentScript: {src: 'https://vinitech.dev.br/assets/negan.js'},
    createElement: () => new Element(), body: new Element(),
    dispatchEvent() {}, addEventListener() {}, activeElement: null,
  };
  const setTimeout = (fn, delay) => { const id = ++timerId; timers.set(id, {at: now + delay, fn}); return id; };
  vm.runInNewContext(source, {
    document, URL, AbortController, DOMException,
    CustomEvent: class { constructor(name, options) { this.type = name; this.detail = options.detail; } },
    setTimeout, clearTimeout: id => timers.delete(id),
    fetch: async (url, options) => {
      calls.push({url, options, body: JSON.parse(options.body), at: now});
      const response = responses.shift();
      if (!response) throw Error('Unexpected fetch');
      if (typeof response === 'function') return response(options);
      return {ok: response.status >= 200 && response.status < 300, status: response.status, json: async () => response.data};
    },
  });
  return {
    calls, elements, timers,
    async submit(text) { elements.textarea.value = text; elements.form.listeners.submit({preventDefault() {}}); await drain(); },
    async reset() { elements['.restart'].listeners.click(); await drain(); },
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].fn(); await drain();
      }
      now = target; await drain();
    },
    messages(role) { return elements['.messages'].children.filter(item => item.className === `message ${role}`).map(item => item.children[1].textContent); },
  };
}

test('quarta pergunta aguarda limite da IA e preserva histórico sem duplicar mensagens', async () => {
  const w = widget([answer('Onde atende?'), answer('Qual segmento?'), answer('Qual volume?'), limited(), answer('Intermediário'), answer('Pagamento pelo checkout')]);
  await w.submit('Sou técnico de ar-condicionado');
  await w.submit('São Paulo');
  await w.submit('Clínicas');
  await w.submit('100 pesquisas por mês');
  assert.equal(w.calls.length, 4);
  assert.equal(w.calls[3].body.messages.length, 7);
  assert.match(w.elements['.status'].textContent, /60 segundos/);
  assert.equal(w.messages('user').length, 4);
  assert.equal(w.messages('assistant').length, 4); // Greeting plus three answers.
  await w.advance(59000); assert.equal(w.calls.length, 4);
  await w.advance(1000); assert.equal(w.calls.length, 5);
  assert.deepEqual(w.calls[4].body, w.calls[3].body);
  assert.equal(w.messages('user').length, 4);
  assert.equal(w.messages('assistant').at(-1), 'Intermediário');
  assert.match(w.elements['.status'].textContent, /gerada por IA/);
  await w.submit('Como pago?');
  assert.equal(w.calls[5].body.messages.length, 9);
  assert.equal(w.calls[5].body.messages[0].content, 'Sou técnico de ar-condicionado');
  assert.equal(w.timers.size, 0);
});

test('limite persistente faz no máximo duas novas tentativas e mantém aviso explícito', async () => {
  const w = widget([limited(1), limited(2), limited(1)]);
  await w.submit('Como funciona?');
  await w.advance(1000); assert.equal(w.calls.length, 2);
  await w.advance(2000); assert.equal(w.calls.length, 3);
  await w.advance(120000); assert.equal(w.calls.length, 3);
  assert.equal(w.messages('assistant').length, 1);
  assert.equal(w.messages('user').length, 1);
  assert.match(w.elements['.status'].textContent, /Tente novamente mais tarde/);
  assert.equal(w.elements.textarea.value, 'Como funciona?');
  assert.equal(w.elements['.send'].disabled, false);
});

test('espera maior que dois minutos e outros erros não geram chamadas automáticas', async () => {
  for (const response of [limited(121), {status: 429, data: {error: 'Limite de mensagens'}}, {status: 503, data: {error: 'Serviço indisponível'}}]) {
    const w = widget([response]);
    await w.submit('Como funciona?'); await w.advance(180000);
    assert.equal(w.calls.length, 1);
    assert.equal(w.messages('assistant').length, 1);
    assert.equal(w.elements['.send'].disabled, false);
  }
});

test('nova conversa cancela espera e impede tentativa da conversa anterior', async () => {
  const w = widget([limited(60), answer('Nova resposta')]);
  await w.submit('Sou técnico de ar-condicionado');
  const firstSignal = w.calls[0].options.signal;
  await w.reset();
  assert.equal(firstSignal.aborted, true);
  await w.advance(120000); assert.equal(w.calls.length, 1);
  assert.equal(w.messages('user').length, 0);
  await w.submit('Sou contador');
  assert.deepEqual(w.calls[1].body.messages, [{role: 'user', content: 'Sou contador'}]);
  assert.equal(w.messages('assistant').at(-1), 'Nova resposta');
});

test('nova conversa aborta requisição pendente sem exibir resposta antiga', async () => {
  const w = widget([options => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('Cancelado', 'AbortError')), {once: true});
  }), answer('Conversa nova')]);
  await w.submit('Pergunta antiga');
  await w.reset();
  assert.equal(w.calls[0].options.signal.aborted, true);
  assert.equal(w.timers.size, 0);
  await w.submit('Pergunta nova');
  assert.equal(w.messages('user').length, 1);
  assert.equal(w.messages('assistant').at(-1), 'Conversa nova');
});

test('tempo de espera não consome os 28 segundos da próxima requisição', async () => {
  const w = widget([limited(60), options => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('Tempo esgotado', 'AbortError')), {once: true});
  })]);
  await w.submit('Como funciona?');
  await w.advance(60000);
  assert.equal(w.calls.length, 2);
  assert.equal(w.calls[1].options.signal.aborted, false);
  await w.advance(27999); assert.equal(w.calls[1].options.signal.aborted, false);
  await w.advance(1); assert.equal(w.calls[1].options.signal.aborted, true);
  assert.match(w.elements['.status'].textContent, /demorou mais que o esperado/);
  assert.equal(w.elements['.send'].disabled, false);
  assert.equal(w.timers.size, 0);
});
