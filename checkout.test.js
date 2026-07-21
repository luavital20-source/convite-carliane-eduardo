// Teste rápido da função /api/checkout — roda com: node checkout.test.js
// Não chama a API real: usa um mock de fetch e um mock de req/res.
const assert = require('assert');

process.env.INFINITEPAY_HANDLE = 'handle-teste';
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
function mockReq(method, body, url) {
  return {
    method,
    body,
    url: url || '/api/checkout',
    headers: { origin: 'https://convite.example' },
  };
}

let capturedInit = null;
function fetchOk() {
  global.fetch = async (url, init) => {
    capturedInit = { url, init };
    return {
      ok: true,
      status: 200,
      json: async () => ({ url: 'https://checkout.infinitepay.com.br/handle-teste?lenc=abc123' }),
    };
  };
}
function fetchNotEnabled() {
  global.fetch = async () => ({
    ok: false,
    status: 404,
    json: async () => ({
      success: false,
      error: 'external_checkout_not_enabled',
      message: 'External checkout is not enabled for this merchant.',
    }),
  });
}

// ── testes ─────────────────────────────────────────────────────────
(async () => {
  // 1) Rejeita GET com 405
  {
    const res = mockRes();
    await handler(mockReq('GET', {}), res);
    assert.strictEqual(res.statusCode, 405, 'GET deveria ser 405');
  }

  // 2) Rejeita amount inválido
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

  // 4) Sucesso: monta payload certo e devolve a url
  {
    fetchOk();
    const res = mockRes();
    await handler(mockReq('POST', { title: 'Ajuda na lua de mel', amount: 20000 }), res);

    assert.strictEqual(res.statusCode, 200, 'deveria ser 200');
    assert.strictEqual(
      res.body.url,
      'https://checkout.infinitepay.com.br/handle-teste?lenc=abc123',
      'url errada'
    );

    assert.strictEqual(capturedInit.url, 'https://api.checkout.infinitepay.io/links');
    assert.strictEqual(capturedInit.init.method, 'POST');
    // Sem token/Authorization: o InfinitePay não exige autenticação.
    assert.ok(!capturedInit.init.headers.Authorization, 'não deveria enviar Authorization');

    const payload = JSON.parse(capturedInit.init.body);
    assert.strictEqual(payload.handle, 'handle-teste');
    assert.strictEqual(payload.items.length, 1);
    assert.strictEqual(payload.items[0].description, 'Ajuda na lua de mel');
    assert.strictEqual(payload.items[0].quantity, 1);
    assert.strictEqual(payload.items[0].price, 20000, 'price deveria estar em centavos');
    assert.strictEqual(payload.redirect_url, 'https://convite.example');
    assert.ok(payload.order_nsu, 'faltou order_nsu');
  }

  // 5) Checkout não ativado -> mensagem clara
  {
    fetchNotEnabled();
    const res = mockRes();
    await handler(mockReq('POST', { title: 'Presente', amount: 15000 }), res);
    assert.strictEqual(res.statusCode, 404);
    assert.match(res.body.error, /não está ativado/i, 'deveria explicar que falta ativar');
    // Sem ?debug=1 não vaza detalhe interno
    assert.strictEqual(res.body.infinitepay_detail, undefined, 'não deveria expor detalhe');
  }

  // 6) Com ?debug=1 o detalhe aparece
  {
    fetchNotEnabled();
    const res = mockRes();
    await handler(mockReq('POST', { title: 'Presente', amount: 15000 }, '/api/checkout?debug=1'), res);
    assert.ok(res.body.infinitepay_detail, 'com debug=1 deveria expor detalhe');
    assert.strictEqual(res.body.handle_usado, 'handle-teste');
  }

  console.log('OK: todos os testes passaram.');
})().catch((e) => {
  console.error('FALHOU:', e.message);
  process.exit(1);
});
