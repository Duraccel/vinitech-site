const { provisioning } = require('./_mercadopago-checkout');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método não permitido.' });
  const purchase = typeof req.query?.purchase === 'string' ? req.query.purchase.trim().toLowerCase() : '';
  const plan = typeof req.query?.plan === 'string' ? req.query.plan.trim().toLowerCase() : '';
  if (!/^[a-z0-9_-]{1,120}$/.test(purchase) || !['initial', 'professional', 'advanced'].includes(plan)) return res.status(400).json({ state: 'unknown' });
  const result = await provisioning('checkout_status', purchase, plan, '', 'one_time');
  if (!result.ok && !result.payload) return res.status(503).json({ state: 'pending' });
  return res.status(200).json({ state: result.payload?.state || 'pending' });
};