// api/checkout.js
// Função serverless (Vercel, runtime nodejs20.x) que cria um checkout de
// PRODUÇÃO no PagBank e devolve a URL da página de pagamento (link rel="PAY").
//
// O token da API vive APENAS em process.env.PAGBANK_TOKEN (variável de
// ambiente na Vercel). Ele nunca é enviado ao navegador nem impresso em log.
//
// Sem dependências externas: usa o fetch nativo do Node 20 e o crypto nativo.

const { randomUUID } = require('crypto');

// Teto de segurança: nenhum presente passa de R$ 5.000,00 (em centavos).
const MAX_AMOUNT_CENTAVOS = 500000;

// Descobre a URL pública do convite a partir dos cabeçalhos da requisição,
// para mandar o convidado de volta ao site depois de pagar/cancelar.
function descobrirBaseUrl(req) {
  // Preferimos o Origin enviado pelo navegador (ex.: https://convite.vercel.app).
  const origin = req.headers['origin'];
  if (origin) return origin.replace(/\/+$/, '');

  // Fallback: reconstrói a partir do host encaminhado pela Vercel.
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers['host'];
  if (host) return `${proto}://${host}`.replace(/\/+$/, '');

  return '';
}

// Lê e valida o corpo (a Vercel entrega req.body já parseado quando o
// Content-Type é application/json; tratamos também o caso de string).
function lerBody(req) {
  const raw = req.body;
  if (!raw) return {};
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch (e) { return {}; }
  }
  return raw;
}

module.exports = async function handler(req, res) {
  // 1) Só aceitamos POST.
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Método não permitido. Use POST.' });
  }

  // 2) Validação da entrada { title, amount } (amount em CENTAVOS).
  const { title, amount } = lerBody(req);

  if (!Number.isInteger(amount) || amount <= 0 || amount > MAX_AMOUNT_CENTAVOS) {
    return res.status(400).json({
      error: 'Valor inválido. Envie "amount" como inteiro em centavos (1 a 500000).',
    });
  }

  if (typeof title !== 'string' || title.trim().length === 0 || title.length > 120) {
    return res.status(400).json({
      error: 'Título inválido. Envie "title" como texto curto (até 120 caracteres).',
    });
  }
  const nome = title.trim();

  // 3) Token de produção — só existe no servidor.
  const token = process.env.PAGBANK_TOKEN;
  if (!token) {
    return res.status(500).json({
      error: 'Configuração ausente: defina a variável de ambiente PAGBANK_TOKEN na Vercel.',
    });
  }

  // 4) URLs de retorno para o próprio convite.
  const baseUrl = descobrirBaseUrl(req);
  const referenceId = `presente-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Payload mínimo do Checkout do PagBank (produção).
  const payload = {
    reference_id: referenceId,
    customer_modifiable: true,
    items: [
      {
        reference_id: referenceId,
        name: nome,
        quantity: 1,
        unit_amount: amount, // em centavos
      },
    ],
    payment_methods: [
      { type: 'CREDIT_CARD' },
      { type: 'DEBIT_CARD' },
      { type: 'PIX' },
    ],
  };
  // Só enviamos as URLs de retorno se conseguimos descobrir a base.
  if (baseUrl) {
    payload.redirect_url = baseUrl; // volta ao convite após concluir
    payload.return_url = baseUrl;   // volta ao convite após cancelar/concluir
  }

  // 5) Chamada à API de Checkout do PagBank.
  let pagbankResp;
  let dados;
  try {
    pagbankResp = await fetch('https://api.pagseguro.com/checkouts', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'x-idempotency-key': randomUUID(), // um UUID por requisição
      },
      body: JSON.stringify(payload),
    });
    dados = await pagbankResp.json().catch(() => null);
  } catch (e) {
    // Nunca logamos o token; só a mensagem do erro de rede.
    console.error('Falha ao contatar o PagBank:', e && e.message);
    return res.status(502).json({ error: 'Não foi possível contatar o PagBank.' });
  }

  // 6) Se o PagBank recusou, repassamos o status com uma mensagem enxuta.
  if (!pagbankResp.ok) {
    // Log sem token; ajuda a depurar sem vazar credencial.
    console.error('PagBank retornou erro', pagbankResp.status, JSON.stringify(dados));
    return res.status(pagbankResp.status).json({
      error: 'O PagBank recusou a criação do checkout.',
    });
  }

  // 7) Extrai o link de pagamento (rel === "PAY") da resposta.
  const links = (dados && dados.links) || [];
  const pay = links.find((l) => l && String(l.rel).toUpperCase() === 'PAY');

  if (!pay || !pay.href) {
    console.error('Resposta do PagBank sem link PAY:', JSON.stringify(dados));
    return res.status(502).json({ error: 'PagBank não retornou a URL de pagamento.' });
  }

  // 8) Sucesso: devolvemos só a URL para o front-end redirecionar.
  return res.status(200).json({ url: pay.href });
};
