(() => {
  'use strict';
  if (document.getElementById('negan-widget')) return;
  const script = document.currentScript;
  const base = new URL('.', script.src);
  const host = document.createElement('div');
  host.id = 'negan-widget';
  const root = host.attachShadow({mode: 'open'});
  const css = document.createElement('link');
  css.rel = 'stylesheet'; css.href = new URL('negan.css', base).href;
  root.append(css);
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <button class="launcher" aria-expanded="false" aria-controls="negan-panel"><span class="avatar" aria-hidden="true">N</span><span>Fale com o Negan<small>Encontre seu plano</small></span><span aria-hidden="true">↗</span></button>
    <section class="panel" id="negan-panel" role="dialog" aria-modal="true" aria-labelledby="negan-title" hidden>
      <header><span class="avatar" aria-hidden="true">N</span><div><h2 id="negan-title">Negan</h2><p>Assistente virtual · Vini Tech</p></div><button class="close icon" aria-label="Fechar conversa">×</button></header>
      <div class="context"><span>EXTRATOR LEADS</span>Seu próximo passo começa aqui.</div>
      <div class="messages" role="log" aria-label="Conversa com Negan" aria-live="polite" aria-relevant="additions"></div>
      <p class="status" role="status"></p>
      <div class="suggestions" aria-label="Sugestões de perguntas"></div>
      <div class="plan-slot"></div>
      <form><label class="sr-only" for="negan-input">Sua mensagem para o Negan</label><textarea id="negan-input" rows="2" maxlength="1200" placeholder="O que você vende e onde atende?" required></textarea><button class="send" type="submit" aria-label="Enviar mensagem">↑</button></form>
      <footer><button class="restart">Nova conversa</button><a href="https://wa.me/5511947342806?text=Ol%C3%A1!%20Vim%20pelo%20Negan%20e%20quero%20ajuda%20com%20o%20Extrator%20Leads." target="_blank" rel="noopener noreferrer">Falar com a equipe ↗</a><p>Não envie senhas ou dados de pagamento. Mensagens podem ser processadas por IA. <a href="https://vinitech.dev.br/privacidade/" target="_blank" rel="noopener noreferrer">Privacidade</a></p></footer>
    </section>`;
  root.append(wrap); document.body.append(host);
  const $ = s => root.querySelector(s);
  const panel = $('.panel'), launcher = $('.launcher'), input = $('textarea'), log = $('.messages'), status = $('.status');
  const planNames = {initial: 'Inicial', professional: 'Intermediário', advanced: 'Máximo'};
  let history = [], busy = false, controller, returnFocus;
  function event(name, extra = {}) { document.dispatchEvent(new CustomEvent('negan:event', {detail: {name, ...extra}})); }
  function message(text, role) {
    const item = document.createElement('div'); item.className = `message ${role}`;
    const label = document.createElement('span'); label.className = 'speaker'; label.textContent = role === 'user' ? 'Você' : 'Negan';
    const body = document.createElement('p'); body.textContent = text;
    item.append(label, body); log.append(item); log.scrollTop = log.scrollHeight;
  }
  function suggest(items) {
    $('.suggestions').replaceChildren();
    for (const text of items) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = text;
      button.addEventListener('click', () => send(text)); $('.suggestions').append(button);
    }
  }
  function reset() {
    controller?.abort(); history = []; busy = false; $('.send').disabled = false; input.disabled = false; input.value = '';
    log.replaceChildren(); $('.plan-slot').replaceChildren(); status.textContent = '';
    message('Olá! Sou o Negan, assistente virtual da Vini Tech. Vou te ajudar a entender como o Extrator Leads pode facilitar sua busca por empresas. O que você vende e em qual cidade ou região quer prospectar?', 'assistant');
    suggest(['Como funciona?', 'Comparar planos', 'Como é o pagamento?']);
  }
  function open() { returnFocus = document.activeElement; panel.hidden = false; launcher.hidden = true; launcher.setAttribute('aria-expanded', 'true'); input.focus(); event('opened'); }
  function close() { panel.hidden = true; launcher.hidden = false; launcher.setAttribute('aria-expanded', 'false'); (returnFocus && returnFocus !== document.body ? returnFocus : launcher).focus(); }
  function showPlan(key) {
    $('.plan-slot').replaceChildren();
    if (!Object.hasOwn(planNames, key)) return;
    const button = document.createElement('button'); button.className = 'checkout'; button.type = 'button';
    button.textContent = `Conferir plano ${planNames[key]} ↗`;
    button.addEventListener('click', () => {
      const target = document.querySelector(`.plan-button[data-plan="${key}"]`);
      event('plan_clicked', {plan: key});
      if (target) { close(); target.click(); }
      else window.location.assign(`https://vinitech.dev.br/extrator-leads/#planos`);
    });
    $('.plan-slot').append(button);
  }
  function waitForRetry(seconds, signal) {
    return new Promise((resolve, reject) => {
      const cancelled = () => {
        clearTimeout(timer);
        reject(new DOMException('Conversa interrompida.', 'AbortError'));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', cancelled);
        resolve();
      }, seconds * 1000);
      if (signal.aborted) cancelled();
      else signal.addEventListener('abort', cancelled, {once: true});
    });
  }
  async function send(value) {
    const text = value.trim(); if (!text || busy) return;
    if (text.length > 1200) { status.textContent = 'Use até 1.200 caracteres.'; return; }
    busy = true; $('.send').disabled = true; input.disabled = true; input.value = '';
    suggest([]); showPlan(null); message(text, 'user'); status.textContent = 'Negan está preparando uma resposta…';
    const pending = [...history.slice(-14), {role: 'user', content: text}];
    controller = new AbortController(); const current = controller;
    try {
      for (let attempt = 0; ; attempt++) {
        const timeout = setTimeout(() => current.abort(), 28000);
        let response, data;
        try {
          response = await fetch('/api/negan', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({messages: pending}), signal: current.signal});
          data = await response.json();
        } finally { clearTimeout(timeout); }
        if (controller !== current) return;
        if (response.status === 429 && data.code === 'ai_rate_limited') {
          const seconds = Number.isFinite(data.retryAfter) && data.retryAfter > 0 ? Math.ceil(data.retryAfter) : 60;
          if (attempt >= 2 || seconds > 120) throw new Error(data.error || 'A IA continua ocupada. Tente novamente mais tarde ou fale com a equipe.');
          status.textContent = `A IA está com muitas solicitações. Vou tentar novamente em ${seconds} segundos…`;
          await waitForRetry(seconds, current.signal);
          if (controller !== current) return;
          status.textContent = 'Negan está preparando uma resposta…';
          continue;
        }
        if (!response.ok || typeof data.reply !== 'string') throw new Error(data.error || 'Não consegui responder agora. Tente novamente ou fale com a equipe.');
        history = [...pending, {role: 'assistant', content: data.reply}]; message(data.reply, 'assistant');
        status.textContent = data.mode === 'guided' ? 'Respostas guiadas · atendimento personalizado com a equipe.' : 'Resposta gerada por IA. Confira as condições antes de contratar.';
        showPlan(data.plan); suggest(Array.isArray(data.actions) ? data.actions.filter(x => typeof x === 'string').slice(0, 3) : []);
        event('answered', {mode: data.mode});
        break;
      }
    } catch (error) {
      if (controller !== current) return;
      status.textContent = error.name === 'AbortError' ? 'A resposta demorou mais que o esperado. Tente novamente ou fale com a equipe.' : error.message;
      input.value = text; suggest(['Comparar planos']);
    } finally {
      if (controller === current) { busy = false; $('.send').disabled = false; input.disabled = false; if (!panel.hidden) input.focus(); }
    }
  }
  launcher.addEventListener('click', open); $('.close').addEventListener('click', close);
  $('.restart').addEventListener('click', () => { controller?.abort(); controller = null; reset(); input.focus(); });
  $('form').addEventListener('submit', e => { e.preventDefault(); send(input.value); });
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(input.value); } });
  panel.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    if (e.key === 'Tab') {
      const elements = [...panel.querySelectorAll('button:not(:disabled), a[href], textarea:not(:disabled)')].filter(el => !el.hidden && el.getClientRects().length);
      const first = elements[0], last = elements.at(-1);
      if (e.shiftKey && root.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && root.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
  document.addEventListener('click', e => { if (e.target.closest('[data-open-negan]')) open(); });
  reset();
})();
