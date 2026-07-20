// Teste rápido da função /api/checkout — roda com: node api/checkout.test.js
// Não chama a API real: usa um mock de fetch e um mock de req/res.
const assert = require('assert');
const handler = require('./api/checkout');

// ── mocks ──────────────────────────────────────────────────────────
function mockRes() {
  return {
    statusCode: 0,
    body: null,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(obj) { this.body = obj; return this; },
  };
}
function mockReq(method, body, headers) {
  return { method, body, headers: headers || { origin: 'https://convite.example' } };
}

let capturedInit = null;
function installFetchMock() {
  global.fetch = async (url, init) => {
    capturedInit = { url, init };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        id: 'CHEC_123',
        links: [
          { rel: 'SELF', href: 'https://api.pagseguro.com/checkouts/CHEC_123' },
          { rel: 'PAY', href: 'https://pagseguro.com/checkout/CHEC_123' },
        ],
      }),
    };
  };
}

// ── testes ─────────────────────────────────────────────────────────
(async () => {
  process.env.PAGBANK_TOKEN = 'token-de-teste';

  // 1) Rejeita GET com 405
  {
    const res = mockRes();
    await handler(mockReq('GET', {}), res);
    assert.strictEqual(res.statusCode, 405, 'GET deveria ser 405');
  }

  // 2) Rejeita amount inválido (não inteiro / negativo / acima do teto)
  for (const bad of [0, -100, 1.5, 500001, '15000', null, undefined]) {
    const res = mockRes();
    await handler(mockReq('POST', { title: 'Presente', amount: bad }), res);
    assert.strictEqual(res.statusCode, 400, `amount=${bad} deveria ser 400`);
  }

  // 3) Rejeita title inválido
  {
    const res = mockRes();
    await handler(mockReq('POST', { title: '', amount: 15000 }), res);
    assert.strictEqual(res.statusCode, 400, 'title vazio deveria ser 400');
  }

  // 4) Falta token -> 500
  {
    delete process.env.PAGBANK_TOKEN;
    const res = mockRes();
    await handler(mockReq('POST', { title: 'Presente', amount: 15000 }), res);
    assert.strictEqual(res.statusCode, 500, 'sem token deveria ser 500');
    process.env.PAGBANK_TOKEN = 'token-de-teste';
  }

  // 5) Sucesso: monta payload certo e devolve o link rel=PAY
  {
    installFetchMock();
    const res = mockRes();
    await handler(mockReq('POST', { title: 'Ajuda na lua de mel', amount: 20000 }), res);

    assert.strictEqual(res.statusCode, 200, 'deveria ser 200');
    assert.strictEqual(res.body.url, 'https://pagseguro.com/checkout/CHEC_123', 'url PAY errada');

    // Verifica a chamada ao PagBank
    assert.strictEqual(capturedInit.url, 'https://api.pagseguro.com/checkouts');
    assert.strictEqual(capturedInit.init.method, 'POST');
    assert.strictEqual(capturedInit.init.headers.Authorization, 'Bearer token-de-teste');
    assert.ok(capturedInit.init.headers['x-idempotency-key'], 'faltou x-idempotency-key');

    const payload = JSON.parse(capturedInit.init.body);
    assert.strictEqual(payload.items.length, 1);
    assert.strictEqual(payload.items[0].name, 'Ajuda na lua de mel');
    assert.strictEqual(payload.items[0].quantity, 1);
    assert.strictEqual(payload.items[0].unit_amount, 20000, 'unit_amount deveria estar em centavos');
    assert.strictEqual(payload.customer_modifiable, true);
    const tipos = payload.payment_methods.map((p) => p.type);
    assert.deepStrictEqual(tipos, ['CREDIT_CARD', 'DEBIT_CARD', 'PIX']);
    assert.strictEqual(payload.redirect_url, 'https://convite.example');
    assert.strictEqual(payload.return_url, 'https://convite.example');
  }

  console.log('OK: todos os testes passaram.');
})().catch((e) => {
  console.error('FALHOU:', e.message);
  process.exit(1);
});
