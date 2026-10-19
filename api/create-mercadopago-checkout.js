// New purchases migrated to Cakto; historical handlers remain intact.
module.exports = async function handler(req, res) {
 res.setHeader('Cache-Control', 'no-store');
 if (req.method !== 'POST') return res.status(405).json({error:'Método não permitido.'});
 const plan = ['initial','professional','advanced'].includes(req.body?.plan) ? req.body.plan : 'professional';
 return res.status(410).json({error:'As novas compras agora são feitas pela Cakto.',provider:'cakto',url:`https://app.vinitech.dev.br/comprar?plano=${plan}`});
};
