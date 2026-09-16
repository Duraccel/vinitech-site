const attempts = new Map();

async function fetchWithTimeout(url, options, timeoutMs = 8000) {
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
    const body = await Promise.race([response.text(), deadline]);
    return { response, body };
  } finally { clearTimeout(timeout); }
}

function allowRequest(req) {
  const key = String(req.headers?.['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim().slice(0, 80);
  if (key === 'unknown') return true;
  const now = Date.now();
  const recent = (attempts.get(key) || []).filter((time) => now - time < 60000);
  recent.push(now);
  attempts.set(key, recent);
  return recent.length <= 8;
}

function configured() {
  const url = process.env.MERCADOPAGO_PROVISIONING_URL;
  const token = process.env.EXTRATOR_PROVISIONING_TOKEN;
  try {
    return Boolean(token && url && new URL(url).protocol === 'https:');
  } catch { return false; }
}

async function provisioning(type, purchaseId, planKey, deliveryEmail, checkoutKind, providerResourceId, registration) {
  if (!configured()) return { ok: false, code: 'not_configured' };
  const externalReference = `vini-tech:${planKey}:${purchaseId}`;
  const eventId = `${type}:${purchaseId}`;
  try {
    const { response, body } = await fetchWithTimeout(process.env.MERCADOPAGO_PROVISIONING_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.EXTRATOR_PROVISIONING_TOKEN}`, 'Content-Type': 'application/json', 'X-Payment-Provider': 'mercadopago', 'X-MercadoPago-Event-Id': eventId },
      body: JSON.stringify({ provider: 'mercadopago', type, event: { id: eventId, external_reference: externalReference }, resource: { ...registration, id: purchaseId, purchase_id: purchaseId, provider_resource_id: providerResourceId, delivery_email: deliveryEmail, checkout_kind: checkoutKind, environment: process.env.MERCADOPAGO_ENVIRONMENT, external_reference: externalReference, status: 'pending' } }),
    });
    let payload = {};
    try { payload = JSON.parse(body); } catch {}
    if (type === 'organization_registration') return { ok: (response.status === 200 || response.status === 201) && payload.registered === true, status: response.status, payload };
    if (type === 'checkout_preflight') return { ok: response.status === 200 && payload.authorized === true && payload.purchase_reference === purchaseId, status: response.status, payload };
    if (type === 'checkout_finalize') return { ok: response.status === 200 && payload.bound === true, status: response.status, payload };
    if (type === 'checkout_status') return { ok: response.status === 200, status: response.status, payload };
    return { ok: response.status === 200 && payload.aborted === true, status: response.status, payload };
  } catch (error) { return { ok: false, code: error?.name === 'AbortError' ? 'timeout' : 'network' }; }
}

function validCheckoutUrl(value, environment) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return '';
    if (environment === 'test') return url.hostname === 'sandbox.mercadopago.com.br' ? url.toString() : '';
    return /(^|\.)mercadopago\.com\.br$/.test(url.hostname) && url.hostname !== 'sandbox.mercadopago.com.br' ? url.toString() : '';
  } catch { return ''; }
}

module.exports = { allowRequest, provisioning, validCheckoutUrl };