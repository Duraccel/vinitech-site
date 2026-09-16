const PLAN_DEFINITIONS = Object.freeze({
  initial: { name: 'Inicial', amount: 37.90 },
  professional: { name: 'Intermediário', amount: 57.90 },
  advanced: { name: 'Máximo', amount: 97.90 },
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

function validProvisioningUrl(value) {
  try { return new URL(value).protocol === 'https:'; } catch { return false; }
}

async function cancelSubscription(accessToken, subscriptionId) {
  try {
    const response = await fetchWithTimeout(`https://api.mercadopago.com/preapproval/${encodeURIComponent(subscriptionId)}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'cancelled' }),
    }, 8000);
    return response.ok;
  } catch {
    return false;
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Método não permitido.' });
  if (process.env.MERCADOPAGO_CHECKOUT_ENABLED !== 'true') return json(res, 503, { error: 'O checkout está temporariamente indisponível.' });
  if (!allowRequest(req)) return json(res, 429, { error: 'Muitas tentativas. Aguarde um minuto e tente novamente.' });

  const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN;
  if (!accessToken) return json(res, 503, { error: 'Mercado Pago ainda não configurado.' });
  const mercadoPagoEnvironment = process.env.MERCADOPAGO_ENVIRONMENT;
  if (!['production', 'test'].includes(mercadoPagoEnvironment)) {
    console.error('Mercado Pago checkout unavailable', { reason: 'environment_not_configured' });
    return json(res, 503, { error: 'O checkout temporariamente não pôde ser iniciado. Tente novamente em instantes.' });
  }

  const body = parseBody(req);
  const planKey = typeof body.plan === 'string' ? body.plan : 'professional';
  const plan = PLAN_DEFINITIONS[planKey];
  if (!plan) return json(res, 400, { error: 'Plano inválido.' });

  const deliveryEmail = validEmail(body.delivery_email);
  if (!deliveryEmail) return json(res, 400, { error: 'Informe um e-mail válido para receber o acesso.' });
  const organizationName = validName(body.organization_name, 80);
  const contactName = validName(body.contact_name, 100);
  if (!organizationName || !contactName || body.terms_accepted !== true) return json(res, 400, { error: 'Informe empresa, responsável e aceite os termos para continuar.' });
  // A assinatura do Mercado Pago pertence ao pagador. Nunca use o endereço
  // de entrega como fallback: as duas identidades podem ser diferentes.
  const payerEmail = validEmail(body.payer_email);
  if (!payerEmail) return json(res, 400, { error: 'Informe o e-mail do pagador no Mercado Pago para a assinatura.' });

  const provisioningUrl = process.env.MERCADOPAGO_PROVISIONING_URL;
  const provisioningToken = process.env.EXTRATOR_PROVISIONING_TOKEN;
  if (!provisioningUrl || !validProvisioningUrl(provisioningUrl) || !provisioningToken) {
    console.error('Lead Engine provisioning unavailable', { reason: 'not_configured' });
    return json(res, 503, { error: 'O checkout temporariamente não pôde ser iniciado. Tente novamente em instantes.' });
  }

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://vinitech.dev.br';
  // A página pública não recebe um organization_id confiável. O Lead Engine
  // resolve o destinatário pelo delivery_email da intenção autenticada, após
  // validar a assinatura. Namespace the reference so unrelated Mercado Pago
  // products from the same account cannot enter the Lead Engine flow.
  const purchaseId = `sub_${crypto.randomUUID().replaceAll('-', '')}`;
  const externalReference = `vini-tech:${planKey}:${purchaseId}`;
  const registration = await provisioning('organization_registration', purchaseId, planKey, deliveryEmail, 'subscription', undefined, {
    organization_name: organizationName,
    contact_name: contactName,
    terms_accepted: true,
    terms_accepted_at: new Date().toISOString(),
  });
  if (!registration.ok) {
    console.error('Lead Engine registration rejected', { code: registration.code || 'http', status: registration.status });
    return json(res, 503, { error: 'Não foi possível concluir o cadastro agora. Tente novamente em instantes.' });
  }
  const preflight = await provisioning('checkout_preflight', purchaseId, planKey, deliveryEmail, 'subscription');
  if (!preflight.ok) {
    console.error('Mercado Pago subscription preflight rejected', { code: preflight.code || 'http', status: preflight.status });
    return json(res, 503, { error: 'O checkout temporariamente não pôde ser iniciado. Confirme seu cadastro e tente novamente.' });
  }
  const subscription = {
    reason: `Extrator Leads — Plano ${plan.name}`,
    external_reference: externalReference,
    payer_email: payerEmail,
    auto_recurring: {
      frequency: 1,
      frequency_type: 'months',
      transaction_amount: plan.amount,
      currency_id: 'BRL',
    },
    back_url: `${siteUrl}/extrator-leads/sucesso.html?provider=mercadopago&purchase=${encodeURIComponent(purchaseId)}&plan=${encodeURIComponent(planKey)}`,
    status: 'pending',
  };
  try {
    const response = await fetchWithTimeout('https://api.mercadopago.com/preapproval', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(subscription),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error('Mercado Pago checkout error', { status: response.status });
      return json(res, 502, { error: 'Não foi possível iniciar o pagamento no Mercado Pago.' });
    }

    const isTest = mercadoPagoEnvironment === 'test';
    const rawUrl = isTest ? payload.sandbox_init_point : payload.init_point;
    const url = validCheckoutUrl(rawUrl, mercadoPagoEnvironment);
    if (!url) {
      console.error('Mercado Pago checkout missing init point', { hasId: Boolean(payload.id), status: payload.status });
      await provisioning('checkout_abort', purchaseId, planKey, deliveryEmail, 'subscription');
      return json(res, 502, { error: 'O Mercado Pago não retornou o endereço do checkout.' });
    }
    if (!payload.id || typeof payload.id !== 'string') {
      console.error('Mercado Pago checkout missing subscription id');
      return json(res, 502, { error: 'O Mercado Pago não retornou uma assinatura válida.' });
    }
    const intent = await provisioning('checkout_finalize', purchaseId, planKey, deliveryEmail, 'subscription', payload.id);
    if (!intent.ok) {
      const canceled = await cancelSubscription(accessToken, payload.id);
      await provisioning('checkout_abort', purchaseId, planKey, deliveryEmail, 'subscription', payload.id);
      console.error('Lead Engine provisioning unavailable', {
        reason: intent.reason,
        status: intent.status,
        mercadoPagoSubscriptionCanceled: canceled,
      });
      return json(res, 503, { error: 'O checkout temporariamente não pôde ser iniciado. Tente novamente em instantes.' });
    }
    return json(res, 200, { provider: 'mercadopago', url, status: payload.status, purchase: purchaseId });
  } catch (error) {
    console.error('Mercado Pago request error', { errorType: error instanceof Error ? error.name : 'unknown' });
    return json(res, 502, { error: 'Não foi possível conectar ao Mercado Pago.' });
  }
};