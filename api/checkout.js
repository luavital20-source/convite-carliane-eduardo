// api/checkout.js
// Função serverless (Vercel, Node 20) que cria um link de pagamento no
// InfinitePay (Checkout Integrado) e devolve a URL da página de pagamento.
//
// O InfinitePay NÃO exige token/autenticação: basta o "handle" (a InfiniteTag
// da conta, sem o "$"). O handle vem de INFINITEPAY_HANDLE, com um padrão
// embutido, para poder ser corrigido na Vercel sem alterar o código.
//
// Sem dependências externas: usa o fetch nativo do Node 20.

// Handle (InfiniteTag) da conta que vai RECEBER os presentes.
// Padrão: a conta da noiva (Carliane). Pode ser sobrescrito na Vercel pela
// variável INFINITEPAY_HANDLE, mas o padrão já é o correto — assim o site
// nunca cai numa conta errada caso a variável falte.
const HANDLE = (process.env.INFINITEPAY_HANDLE || 'venancio-carliane-t66')
  .replace(/^\$/, '')
  .trim();

// Teto de segurança: nenhum presente passa de R$ 5.000,00 (em centavos).
const MAX_AMOUNT_CENTAVOS = 500000;

// Descobre a URL pública do convite, para o convidado voltar ao site após pagar.
function descobrirBaseUrl(req) {
  const origin = req.headers['origin'];
  if (origin) return origin.replace(/\/+$/, '');

  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers['host'];
  if (host) return `${proto}://${host}`.replace(/\/+$/, '');

  return '';
}

// Lê o corpo (a Vercel entrega req.body parseado quando o Content-Type é JSON).
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

  // 3) O handle precisa existir (é o "endereço" que recebe o dinheiro).
  if (!HANDLE) {
    return res.status(500).json({
      error: 'Configuração ausente: defina INFINITEPAY_HANDLE (a InfiniteTag, sem o "$").',
    });
  }

  const baseUrl = descobrirBaseUrl(req);
  const orderNsu = `presente-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // 4) Payload do Checkout do InfinitePay. Preço em centavos.
  const payload = {
    handle: HANDLE,
    order_nsu: orderNsu,
    items: [
      {
        quantity: 1,
        price: amount,      // em centavos
        description: nome,
      },
    ],
  };
  // Volta para o convite depois que o pagamento for concluído.
  if (baseUrl) payload.redirect_url = baseUrl;

  // 5) Chamada à API de Checkout do InfinitePay (sem token).
  let apiResp;
  let dados;
  try {
    apiResp = await fetch('https://api.checkout.infinitepay.io/links', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
    });
    dados = await apiResp.json().catch(() => null);
  } catch (e) {
    console.error('Falha ao contatar o InfinitePay:', e && e.message);
    return res.status(502).json({ error: 'Não foi possível contatar o InfinitePay.' });
  }

  // 6) Se o InfinitePay recusou, repassamos o status com mensagem enxuta.
  if (!apiResp.ok || !dados || !dados.url) {
    console.error('InfinitePay retornou erro', apiResp.status, JSON.stringify(dados));

    // Erro mais comum: o Checkout Integrado ainda não foi ativado na conta.
    const naoAtivado = dados && dados.error === 'external_checkout_not_enabled';
    const resposta = {
      error: naoAtivado
        ? 'O Checkout Integrado ainda não está ativado na conta InfinitePay.'
        : 'O InfinitePay recusou a criação do link de pagamento.',
    };
    return res.status(apiResp.ok ? 502 : apiResp.status).json(resposta);
  }

  // 7) Sucesso: devolvemos só a URL para o front-end redirecionar.
  return res.status(200).json({ url: dados.url });
};
