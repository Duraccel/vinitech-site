const PLAN_DEFINITIONS = Object.freeze({
  initial: { name: 'Inicial', amount: 37.90, quota: 50 },
  professional: { name: 'Intermediário', amount: 57.90, quota: 200 },
  advanced: { name: 'Máximo', amount: 97.90, quota: 500 },
});
const { allowRequest, provisioning, validCheckoutUrl } = require('./_mercadopago-checkout');

function json(res, status, body) {
  return res.status(status).json(body);
}

async function fetchWithTimeout(url, options, timeoutMs = 10000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timeout); }
}

function parseBody(req) {
  if (!req.body) return {};
  if (Buffer.isBuffer(req.body)) {
    try { return JSON.parse(req.body.toString('utf8')); } catch { return {}; }
  }
  if (typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body); } catch { return {}; }
}

function validEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

function validName(value, maximum) {
  const text = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  return text.length >= 2 && text.length <= maximum ? text : '';
}

function validSiteUrl(value) {
  try { return new URL(value).protocol === 'https:'; } catch { return false; }
}

function validProvisioningUrl(value) {
  try { return new URL(value).protocol === 'https:'; } catch { return false; }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Método não permitido.' });
  if (process.env.MERCADOPAGO_CHECKOUT_ENABLED !== 'true') return json(res, 503, { error: 'O checkout está temporariamente indisponível.' });
  if (!allowRequest(req)) return json(res, 429, { error: 'Muitas tentativas. Aguarde um minuto e tente novamente.' });

  const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN;
  if (!accessToken) return json(res, 503, { error: 'Mercado Pago ainda não configurado.' });
  const mercadoPagoEnvironment = process.env.MERCADOPAGO_ENVIRONMENT;
  if (!['production', 'test'].includes(mercadoPagoEnvironment)) {
    console.error('Mercado Pago payment unavailable', { reason: 'environment_not_configured' });
    return json(res, 503, { error: 'O pagamento temporariamente não pôde ser iniciado. Tente novamente em instantes.' });
  }

  const body = parseBody(req);
  const planKey = typeof body.plan === 'string' ? body.plan.trim().toLowerCase() : 'professional';
  const plan = PLAN_DEFINITIONS[planKey];
  if (!plan) return json(res, 400, { error: 'Plano inválido.' });

  // Checkout Pro coleta a identidade do pagador no ambiente do Mercado Pago.
  // O e-mail informado no site identifica somente quem receberá o acesso.
  // Aceitar o campo legado `email` aqui evita interromper uma página ainda em
  // cache, sem voltar a tratá-lo como identidade do pagador.
  const deliveryEmail = validEmail(body.delivery_email || body.email);
  if (!deliveryEmail) return json(res, 400, { error: 'Informe um e-mail válido para receber o acesso.' });
  const organizationName = validName(body.organization_name, 80);
  const contactName = validName(body.contact_name, 100);
  if (!organizationName || !contactName || body.terms_accepted !== true) return json(res, 400, { error: 'Informe empresa, responsável e aceite os termos para continuar.' });

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://vinitech.dev.br';
  if (!validSiteUrl(siteUrl)) return json(res, 503, { error: 'O pagamento temporariamente não pôde ser iniciado. Tente novamente em instantes.' });
  const provisioningUrl = process.env.MERCADOPAGO_PROVISIONING_URL;
  const provisioningToken = process.env.EXTRATOR_PROVISIONING_TOKEN;
  if (!provisioningUrl || !validProvisioningUrl(provisioningUrl) || !provisioningToken) {
    console.error('Mercado Pago payment unavailable', { reason: 'provisioning_not_configured' });
    return json(res, 503, { error: 'O pagamento temporariamente não pôde ser iniciado. Tente novamente em instantes.' });
  }

  const checkoutReference = `pay_${crypto.randomUUID().replaceAll('-', '')}`;
  const externalReference = `vini-tech:${planKey}:${checkoutReference}`;
  const registration = await provisioning('organization_registration', checkoutReference, planKey, deliveryEmail, 'one_time', undefined, {
    organization_name: organizationName,
    contact_name: contactName,
    terms_accepted: true,
    terms_accepted_at: new Date().toISOString(),
  });
  if (!registration.ok) {
    console.error('Lead Engine registration rejected', { code: registration.code || 'http', status: registration.status });
    return json(res, 503, { error: 'Não foi possível concluir o cadastro agora. Tente novamente em instantes.' });
  }
  const preflight = await provisioning('checkout_preflight', checkoutReference, planKey, deliveryEmail, 'one_time');
  if (!preflight.ok) {
    console.error('Mercado Pago checkout preflight rejected', { code: preflight.code || 'http', status: preflight.status });
    return json(res, 503, { error: 'O checkout temporariamente não pôde ser iniciado. Confirme seu cadastro e tente novamente.' });
  }

  const preference = {
    items: [{
      id: `extrator-${planKey}`,
      title: `Extrator Leads — Plano ${plan.name} (ciclo de 30 dias)`,
      quantity: 1,
      currency_id: 'BRL',
      unit_price: plan.amount,
    }],
    external_reference: externalReference,
    back_urls: {
      success: `${siteUrl}/extrator-leads/sucesso.html?provider=mercadopago&mode=one_time&purchase=${encodeURIComponent(checkoutReference)}&plan=${encodeURIComponent(planKey)}`,
      pending: `${siteUrl}/extrator-leads/sucesso.html?provider=mercadopago&mode=one_time&purchase=${encodeURIComponent(checkoutReference)}&plan=${encodeURIComponent(planKey)}`,
      failure: `${siteUrl}/extrator-leads/cancelado.html?provider=mercadopago&mode=one_time`,
    },
    auto_return: 'approved',
    // Vercel canonicalizes this project with a trailing slash. Webhook
    // providers should post directly to the canonical URL rather than rely
    // on following a 308 redirect for a signed notification.
    notification_url: `${siteUrl}/api/mercadopago-webhook/`,
    // This route is deliberately one-time: credit-card subscriptions remain
    // on /preapproval. Excluding credit card avoids presenting a second
    // credit-card path that could be mistaken for automatic renewal.
    payment_methods: {
      excluded_payment_types: [{ id: 'credit_card' }],
      installments: 1,
    },
  };

  try {
    const response = await fetchWithTimeout('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(preference),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error('Mercado Pago payment error', { status: response.status });
      return json(res, 502, { error: 'Não foi possível iniciar o pagamento no Mercado Pago.' });
    }

    const isTest = mercadoPagoEnvironment === 'test';
    const rawUrl = isTest ? payload.sandbox_init_point : payload.init_point;
    const url = validCheckoutUrl(rawUrl, mercadoPagoEnvironment);
    if (!url || !payload.id || typeof payload.id !== 'string') {
      console.error('Mercado Pago payment missing checkout data', { hasId: Boolean(payload.id) });
      await provisioning('checkout_abort', checkoutReference, planKey, deliveryEmail, 'one_time');
      return json(res, 502, { error: 'O Mercado Pago não retornou um checkout válido.' });
    }
    const finalized = await provisioning('checkout_finalize', checkoutReference, planKey, deliveryEmail, 'one_time', payload.id);
    if (!finalized.ok) {
      await provisioning('checkout_abort', checkoutReference, planKey, deliveryEmail, 'one_time', payload.id);
      console.error('Mercado Pago payment binding unavailable', { code: finalized.code || 'http', status: finalized.status });
      return json(res, 503, { error: 'O checkout temporariamente não pôde ser iniciado. Tente novamente em instantes.' });
    }
    return json(res, 200, { provider: 'mercadopago', url, status: 'pending', mode: 'one_time', purchase: checkoutReference });
  } catch (error) {
    console.error('Mercado Pago payment request error', { errorType: error instanceof Error ? error.name : 'unknown' });
    return json(res, 502, { error: 'Não foi possível conectar ao Mercado Pago.' });
  }
};