const { timingSafeEqual } = require('node:crypto');

const EXPECTED_APP_HOST = 'app.vinitech.dev.br';
const PROVISIONING_PATH = '/api/billing/mercadopago-provisioning';
const RUNNER_PATH = '/api/billing/mercadopago-runner';

function equalSecret(expected, supplied) {
  const left = Buffer.from(expected);
  const right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
}

function getRunnerUrl() {
  const configured = process.env.MERCADOPAGO_PROVISIONING_URL?.trim();
  if (!configured) return null;
  try {
    const url = new URL(configured);
    if (url.protocol !== 'https:' || url.hostname !== EXPECTED_APP_HOST || url.pathname.replace(/\/$/, '') !== PROVISIONING_PATH) return null;
    url.pathname = RUNNER_PATH;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método não permitido.' });

  const cronSecret = process.env.CRON_SECRET?.trim() ?? '';
  const supplied = req.headers?.authorization?.replace(/^Bearer\s+/i, '') ?? '';
  if (!cronSecret) return res.status(503).json({ error: 'Recuperação temporariamente indisponível.' });
  if (!supplied || !equalSecret(cronSecret, supplied)) return res.status(401).json({ error: 'Não autorizado.' });

  const provisioningToken = process.env.EXTRATOR_PROVISIONING_TOKEN?.trim() ?? '';
  const runnerUrl = getRunnerUrl();
  if (!provisioningToken || !runnerUrl) return res.status(503).json({ error: 'Recuperação temporariamente indisponível.' });

  try {
    const response = await fetch(runnerUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${provisioningToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      console.error('mercadopago_runner_failed', { status: response.status });
      return res.status(502).json({ error: 'Não foi possível concluir a recuperação.' });
    }
    const result = await response.json().catch(() => ({}));
    return res.status(200).json({
      processed: result.processed === true,
      deliveryRecovered: Number.isSafeInteger(result.deliveryRecovered) ? result.deliveryRecovered : 0,
      processingRecovered: Number.isSafeInteger(result.processingRecovered) ? result.processingRecovered : 0,
    });
  } catch (error) {
    console.error('mercadopago_runner_unavailable', { reason: error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'network' });
    return res.status(502).json({ error: 'Não foi possível concluir a recuperação.' });
  }
};