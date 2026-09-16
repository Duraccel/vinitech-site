const crypto = require('crypto');

function json(res, status, body) {
  return res.status(status).json(body);
}

function parseBody(req) {
  if (!req.body) return {};
  if (Buffer.isBuffer(req.body)) {
    try { return JSON.parse(req.body.toString('utf8')); } catch { return {}; }
  }
  if (typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body); } catch { return {}; }
}

function signatureValues(header) {
  return Object.fromEntries(String(header || '').split(',').map((part) => {
    const index = part.indexOf('=');
    return index > 0 ? [part.slice(0, index).trim(), part.slice(index + 1).trim()] : [];
  }).filter(Boolean));
}

function hasValidSignature(req, dataId) {
  const secret = process.env.MERCADOPAGO_WEBHOOK_SECRET;
  const values = signatureValues(req.headers['x-signature']);
  const requestId = headerValue(req.headers['x-request-id']).trim();
  const timestamp = String(values.ts || '').trim();
  const signature = String(values.v1 || '').trim().toLowerCase();
  if (!secret || !/^(?:\d{10}|\d{13})$/.test(timestamp) || !/^[0-9a-f]{64}$/.test(signature) || !requestId || !dataId) return false;
  const timestampMs = timestamp.length === 13 ? Number(timestamp) : Number(timestamp) * 1000;
  const ageMs = Date.now() - timestampMs;
  if (!Number.isFinite(timestampMs) || ageMs < -30000 || ageMs > 300000) return false;
  const signatureDataId = /^[a-z0-9]+$/i.test(dataId) ? dataId.toLowerCase() : dataId;
  const manifest = `id:${signatureDataId};request-id:${requestId};ts:${values.ts};`;
  const expected = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const actualBuffer = Buffer.from(signature, 'utf8');
  return expectedBuffer.length === actualBuffer.length && crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

async function getResource(accessToken, type, id, deadline) {
  const path = type === 'subscription_preapproval'
    ? `/preapproval/${encodeURIComponent(id)}`
    : type === 'subscription_authorized_payment'
      ? `/authorized_payments/${encodeURIComponent(id)}`
      : type === 'topic_chargebacks_wh'
        ? `/v1/chargebacks/${encodeURIComponent(id)}`
        : type === 'topic_claims_integration_wh'
          ? `/post-purchase/v1/claims/${encodeURIComponent(id)}`
      : `/v1/payments/${encodeURIComponent(id)}`;
  const response = await fetchWithTimeout(`https://api.mercadopago.com${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  }, Math.max(1, Math.min(7000, deadline - Date.now())));
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Mercado Pago resource ${response.status}`);
  return payload;
}

function headerValue(value) {
  return Array.isArray(value) ? String(value[0] || '') : typeof value === 'string' ? value : '';
}

function validProvisioningUrl(value) {
  try { return new URL(value).protocol === 'https:'; } catch { return false; }
}

async function fetchWithTimeout(url, options, timeoutMs = 10000) {
  const controller = new AbortController();
  let timeout;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(Object.assign(new Error('request_timeout'), { name: 'AbortError' }));
    }, timeoutMs);
  });
  try {
    const response = await Promise.race([fetch(url, { ...options, signal: controller.signal }), deadline]);
    // Buffer the response while the same abort timer is active. This keeps
    // the timeout bounded across both network headers and a slow response
    // body, not only until fetch() resolves.
    const body = await Promise.race([response.text(), deadline]);
    return new Response(body, { status: response.status, headers: response.headers });
  }
  finally { clearTimeout(timeout); }
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

const VINI_TECH_PLANS = new Set(['initial', 'professional', 'advanced']);

function viniTechPlanFromReference(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const reference = String(value).trim().toLowerCase();
  if (VINI_TECH_PLANS.has(reference)) return reference;
  const match = reference.match(/^vini-tech:(initial|professional|advanced)(?::[a-z0-9][a-z0-9_-]{0,100})?$/);
  return match ? match[1] : '';
}

function provisioningFailureCode(status, responseBody) {
  let message = '';
  try {
    const payload = JSON.parse(responseBody);
    if (payload && typeof payload.error === 'string') message = payload.error.toLowerCase();
  } catch {}

  if (status === 401) return 'authentication_rejected';
  if (status === 403) return 'provisioning_forbidden';
  if (status === 409) return 'provisioning_conflict';
  if (message.includes('plano')) return 'unknown_plan';
  if (message.includes('checkout') || message.includes('referência') || message.includes('referencia')) return 'unmatched_reference';
  if (message.includes('pagador')) return 'invalid_payer_identity';
  if (message.includes('destinat') || message.includes('entrega')) return 'invalid_recipient_identity';
  if (message.includes('evento')) return 'invalid_event';
  if (message.includes('payload')) return 'invalid_payload';
  return `provisioning_http_${Number.isInteger(status) ? status : 'unknown'}`;
}

async function normalizeResource(accessToken, type, payload, deadline) {
  const resource = {};
  for (const key of ['id', 'preapproval_id', 'subscription_id', 'external_reference', 'status', 'payment_status']) {
    if (typeof payload[key] === 'string' || typeof payload[key] === 'number') resource[key] = payload[key];
  }
  if (typeof payload.live_mode === 'boolean') resource.live_mode = payload.live_mode;
  const payer = object(payload.payer);
  if (!resource.payer_email && payer && typeof payer.email === 'string') resource.payer_email = payer.email;
  if (!resource.payer_email && typeof payload.payer_email === 'string') resource.payer_email = payload.payer_email;

  // Authorized-payment notifications identify the invoice, not always the
  // subscription payer. Enrich it from the related preapproval so the Lead
  // Engine can resolve the organization without trusting browser input.
  if ((type === 'subscription_authorized_payment' || type === 'payment') && payload.preapproval_id) {
    const subscription = await getResource(accessToken, 'subscription_preapproval', payload.preapproval_id, deadline);
    if (!resource.preapproval_id && typeof subscription.id === 'string') resource.preapproval_id = subscription.id;
    if (!resource.payer_email && typeof subscription.payer_email === 'string') resource.payer_email = subscription.payer_email;
    if (!resource.external_reference && subscription.external_reference != null) resource.external_reference = subscription.external_reference;
    if (typeof subscription.status === 'string') resource.subscription_status = subscription.status;
  }

  // For recurring invoices, payment.status is the authoritative outcome;
  // `processed` is an invoice lifecycle state, not an approved payment.
  if (type === 'subscription_authorized_payment') {
    const payment = object(payload.payment);
    if (payment && typeof payment.status === 'string') resource.status = payment.status;
    else if (typeof payload.summarized === 'string') resource.status = payload.summarized;
  }
  if (type === 'topic_chargebacks_wh' || type === 'topic_claims_integration_wh') {
    const paymentId = payload.payment_id || payload.payment?.id || payload.resource_id;
    if (!paymentId) throw new Error('provider_resource_invalid');
    const payment = await getResource(accessToken, 'payment', String(paymentId), deadline);
    Object.assign(resource, await normalizeResource(accessToken, 'payment', payment, deadline));
    resource.id = payment.id || paymentId;
    resource.status = type === 'topic_chargebacks_wh' ? 'charged_back' : 'reconciliation_required';
  }
  if (type === 'stop_delivery_op_wh') resource.status = 'reconciliation_required';
  return resource;
}

function normalizedEvent(body, type, dataId, eventId) {
  return {
    id: eventId,
    action: typeof body.action === 'string' ? body.action.slice(0, 120) : undefined,
    type,
    data: { id: dataId },
    live_mode: body.live_mode,
  };
}

module.exports = async function handler(req, res) {
  const startedAt = Date.now();
  if (req.method !== 'POST') return json(res, 405, { error: 'Método não permitido.' });
  if (!process.env.MERCADOPAGO_ACCESS_TOKEN || !process.env.MERCADOPAGO_WEBHOOK_SECRET) {
    return json(res, 503, { error: 'Webhook Mercado Pago ainda não configurado.' });
  }
  const configuredEnvironment = process.env.MERCADOPAGO_ENVIRONMENT;
  if (!['production', 'test'].includes(configuredEnvironment)) return json(res, 503, { error: 'Ambiente Mercado Pago não configurado.' });

  const body = parseBody(req);
  const type = String(req.query?.type || body.type || body.topic || '');
  const dataId = String(req.query?.['data.id'] || req.query?.id || body.data?.id || body.id || '');
  if (!dataId || !['subscription_preapproval', 'subscription_authorized_payment', 'payment', 'topic_chargebacks_wh', 'topic_claims_integration_wh', 'stop_delivery_op_wh'].includes(type)) {
    return json(res, 200, { received: true, ignored: true });
  }
  if (!hasValidSignature(req, dataId)) return json(res, 401, { error: 'Assinatura inválida.' });
  const provisioningUrl = process.env.MERCADOPAGO_PROVISIONING_URL;
  if (!provisioningUrl || !validProvisioningUrl(provisioningUrl) || !process.env.EXTRATOR_PROVISIONING_TOKEN) {
    console.error('Lead Engine provisioning unavailable', { reason: 'not_configured' });
    return json(res, 503, { error: 'Provisionamento do Lead Engine ainda não configurado.' });
  }

  const candidateEventId = typeof body.id === 'string' || typeof body.id === 'number' ? String(body.id).trim() : '';
  const eventId = candidateEventId && candidateEventId.length <= 200
    ? candidateEventId
    : `${type}:${dataId}:${typeof body.action === 'string' ? body.action.slice(0, 80) : 'updated'}`.slice(0, 200);
  try {
    const deadline = Date.now() + 18000;
    const rawResource = await getResource(process.env.MERCADOPAGO_ACCESS_TOKEN, type, dataId, deadline);
    const resource = await normalizeResource(process.env.MERCADOPAGO_ACCESS_TOKEN, type, rawResource, deadline);
    const providerLiveMode = typeof resource.live_mode === 'boolean' ? resource.live_mode : null;
    const expectedLiveMode = configuredEnvironment === 'production';
    if (providerLiveMode === null || providerLiveMode !== expectedLiveMode) return json(res, 422, { error: 'Evento incompatível com o ambiente configurado.' });
    // A Mercado Pago account can receive notifications for products unrelated
    // to the Lead Engine. Query and authenticate them, but forward only a
    // reference belonging to the closed Vini Tech plan catalog. Legacy bare
    // plan keys remain accepted for subscriptions created before this change.
    const planKey = viniTechPlanFromReference(resource.external_reference);
    if (!planKey) {
      return json(res, 200, { received: true, provider: 'mercadopago', eventId, ignored: true });
    }
    const response = await fetchWithTimeout(provisioningUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.EXTRATOR_PROVISIONING_TOKEN || ''}`,
        'Content-Type': 'application/json',
        'X-Payment-Provider': 'mercadopago',
        'X-MercadoPago-Event-Id': eventId,
        'X-Signature': headerValue(req.headers['x-signature']),
        'X-Request-Id': headerValue(req.headers['x-request-id']),
      },
      body: JSON.stringify({ provider: 'mercadopago', type, environment: configuredEnvironment, event: normalizedEvent({ ...body, live_mode: providerLiveMode }, type, dataId, eventId), resource }),
    }, Math.max(1, deadline - Date.now()));
    const responseBody = await response.text().catch(() => '');
    let responsePayload = null;
    try { responsePayload = JSON.parse(responseBody); } catch {}
    const durableAccepted = response.status === 202 && responsePayload?.status === 'accepted_durable';
    if (!response.ok || (response.status === 202 && !durableAccepted)) {
      console.error('Lead Engine provisioning failed', {
        eventId,
        status: response.status,
        rejectionCode: provisioningFailureCode(response.status, responseBody),
        requestIdHash: crypto.createHash('sha256').update(headerValue(req.headers['x-request-id'])).digest('hex').slice(0, 12),
        dataIdHash: crypto.createHash('sha256').update(dataId).digest('hex').slice(0, 12),
        stage: 'lead_engine',
        durationMs: Date.now() - startedAt,
      });
      return json(res, 502, { error: 'Não foi possível provisionar a assinatura.' });
    }
    return json(res, durableAccepted ? 202 : 200, { received: true, provider: 'mercadopago', eventId, status: durableAccepted ? 'accepted_durable' : 'processed' });
  } catch (error) {
    console.error('Mercado Pago webhook error', { eventId, errorType: error instanceof Error ? error.name : 'unknown' });
    return json(res, 502, { error: 'Falha ao processar a notificação do Mercado Pago.' });
  }
};