import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createGateway } from './server.mjs';
test('real auth transport, gateway isolation and streamed upload transport', async (t) => {
  let calls = [];
  let syncEndpoint = 'https://staging.example/powersync';
  const syncPayload = {
    schemaVersion: 1,
    token: 'genuine-upstream-jwt',
    expiresAt: '2026-09-17T12:30:00.000Z',
    writeScope: {
      clientId: 'actual-client',
      spaces: [{ id: 'actual-space', visibility: 'private' }],
    },
  };
  const upstream = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    calls.push({ url: req.url, headers: req.headers, body });
    if (req.url === '/api/auth/sign-in/email') {
      res.setHeader(
        'set-cookie',
        '__Secure-emdo.session_token=real-token; Path=/; HttpOnly; Domain=localhost',
      );
      res.end('{}');
    } else if (req.url.startsWith('/api/v1/sync/token?')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ...syncPayload, endpoint: syncEndpoint }));
    } else if (req.url === '/') {
      res.setHeader('content-type', 'text/html');
      res.end('<body>Actual staging</body>');
    } else res.end(JSON.stringify({ actual: true }));
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const gateway = createGateway({
    upstream: `http://127.0.0.1:${upstream.address().port}`,
    publicOrigin: 'https://test.example',
    authOrigin: 'https://staging.example',
    expiryEpoch: Date.now() + 3600000,
    secret: 'x'.repeat(48),
    email: 'owner@synthetic.invalid',
    password: 'strong-password-123',
  });
  await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
  t.after(() => {
    gateway.closeAllConnections();
    upstream.closeAllConnections();
    gateway.close();
    upstream.close();
  });
  const base = `http://127.0.0.1:${gateway.address().port}`;
  const request = (p, init = {}) =>
    fetch(base + p, { redirect: 'manual', ...init });
  assert.equal((await request('/api/v2/workspace')).status, 401);
  assert.equal(calls.length, 0);
  assert.equal(
    (await request('/preview/login', { method: 'POST' })).status,
    403,
  );
  const login = (body) =>
    request('/preview/login', {
      method: 'POST',
      headers: {
        origin: 'https://test.example',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
    });
  assert.equal((await login('username=test&password=wrong')).status, 401);
  const response = await login('username=test&password=test');
  assert.equal(response.status, 303);
  const cookies = response.headers.getSetCookie();
  assert.ok(
    cookies.every((c) => c.includes('Secure') && !c.includes('Domain=')),
  );
  const cookie = cookies.map((c) => c.split(';')[0]).join('; ');
  assert.deepEqual(JSON.parse(calls[0].body), {
    email: 'owner@synthetic.invalid',
    password: 'strong-password-123',
  });
  assert.equal(calls[0].headers.origin, 'https://staging.example');
  assert.match(
    await (await request('/', { headers: { cookie } })).text(),
    /SYNTHETIC TEST WORKSPACE/,
  );
  assert.equal(
    (await request('/api/v2/workspace', { headers: { cookie } })).status,
    200,
  );
  assert.ok(!calls.at(-1).headers.cookie.includes('emdo_preview'));
  await request('/powersync/sync/stream', {
    headers: { cookie, authorization: 'Bearer real-sync-jwt' },
  });
  assert.equal(calls.at(-1).headers.authorization, 'Bearer real-sync-jwt');
  await request('/api/v2/workspace', {
    headers: { cookie, authorization: 'Bearer must-not-forward' },
  });
  assert.equal(calls.at(-1).headers.authorization, undefined);
  assert.equal(
    (
      await request('/api/v2/workspace', {
        headers: {
          cookie: cookie.replace(/(__Secure-emdo_preview=)[^;]+/, '$1tampered'),
        },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await request('/api/v2/workspace', {
        method: 'POST',
        headers: { cookie, origin: 'https://attacker.example' },
        body: '{}',
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request('/api/v2/workspace', {
        method: 'POST',
        headers: { cookie, origin: 'https://test.example' },
        body: 'x'.repeat(20 * 1024 * 1024 + 1),
      })
    ).status,
    413,
  );
  assert.equal(
    (
      await request('/api/internal/finance-synthetic/account', {
        headers: { cookie },
      })
    ).status,
    404,
  );
  assert.equal(
    (await request('/%2e%2e%2fsecret', { headers: { cookie } })).status,
    404,
  );
  assert.equal(
    (
      await request('/api/v1/finance/documents', {
        method: 'POST',
        headers: { cookie, origin: 'https://test.example' },
        body: 'private',
      })
    ).status,
    200,
  );
  assert.equal(calls.at(-1).body, 'private');
  assert.equal((await request('/readyz', { headers: { cookie } })).status, 404);
  const beforeUpgrade = calls.length;
  for (const path of [
    '/powersync/../api/internal/private',
    '/powersync/%2e%2e/api/internal/private',
    '/powersync/%252e%252e/api/internal/private',
    '/powersync/%2e%2e/readyz',
    '/powersync/metrics',
  ]) {
    const status = await new Promise((resolve, reject) => {
      const req = http.request(
        base,
        {
          path,
          headers: {
            cookie,
            origin: 'https://test.example',
            connection: 'Upgrade',
            upgrade: 'websocket',
            'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
            'sec-websocket-version': '13',
          },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      req.on('upgrade', (_response, socket) => {
        socket.destroy();
        reject(Error('Traversal upgrade was accepted'));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 403, path);
  }
  assert.equal(
    calls.length,
    beforeUpgrade,
    'Rejected upgrades must never reach upstream',
  );
  const translated = await request(
    '/api/v1/sync/token?clientId=actual-client',
    { headers: { cookie } },
  );
  assert.equal(translated.status, 200);
  assert.deepEqual(await translated.json(), {
    ...syncPayload,
    endpoint: 'https://test.example/powersync',
  });
  syncEndpoint = 'https://untrusted.example/powersync';
  const rejectedSync = await request(
    '/api/v1/sync/token?clientId=actual-client',
    { headers: { cookie } },
  );
  assert.equal(rejectedSync.status, 503);
  assert.ok(!(await rejectedSync.text()).includes(syncPayload.token));
  const out = await request('/api/auth/sign-out', {
    method: 'POST',
    headers: {
      cookie,
      origin: 'https://test.example',
      'x-csrf-token': 'real-csrf',
    },
    body: '{}',
  });
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal(calls.at(-1).headers['x-csrf-token'], 'real-csrf');
});
