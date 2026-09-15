import http from 'node:http';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { Transform } from 'node:stream';
import { pathToFileURL } from 'node:url';

const cookieName = '__Secure-emdo_preview';
const html = `<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>EMDO test login</title><style>body{font:17px system-ui;background:#f2f5f6;color:#182a2d;max-width:420px;margin:12vh auto;padding:24px}form{display:grid;gap:14px}input,button{font:inherit;padding:12px}small{display:block;margin:24px 0}</style><h1>EMDO test workspace</h1><p>Short-lived synthetic staging. Do not enter real personal or financial data.</p><form method="post" action="/preview/login"><label>Username <input name="username" autocomplete="username" required></label><label>Password <input name="password" type="password" autocomplete="current-password" required></label><button>Sign in</button></form><small>Uses the actual staging application. AI and other capabilities depend on staging configuration; no responses are simulated by this gateway.</small></html>`;
const banner =
  '<div style="position:sticky;top:0;z-index:2147483647;background:#fff0b8;color:#352900;padding:8px 14px;text-align:center;font:13px system-ui">EMDO SYNTHETIC TEST WORKSPACE · Short-lived staging · No real personal or financial data · AI availability depends on staging configuration</div>';
const hop = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const safeEqual = (a, b) => {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const secureCookie = (value) =>
  value.replace(/;\s*domain=[^;]*/gi, '').replace(/;\s*secure/gi, '') +
  '; Secure';
function permittedPath(raw) {
  try {
    const path = decodeURIComponent(raw.split('?')[0]);
    if (
      !raw.startsWith('/') ||
      raw.startsWith('//') ||
      path.includes('..') ||
      path.includes('\\') ||
      path.includes('\0') ||
      /%[0-9a-f]{2}/i.test(path) ||
      /\/(internal|metrics)(\/|$)|readiness|\/health|synthetic/i.test(path) ||
      path === '/readyz'
    )
      return undefined;
    return path;
  } catch {
    return undefined;
  }
}
export function createGateway(config) {
  const upstream = new URL(config.upstream);
  if (
    upstream.protocol !== 'http:' ||
    upstream.hostname !== '127.0.0.1' ||
    upstream.pathname !== '/' ||
    upstream.search ||
    upstream.username ||
    upstream.password
  )
    throw Error('Fixed IPv4 loopback HTTP upstream required');
  if (
    !Number.isFinite(config.expiryEpoch) ||
    config.expiryEpoch <= Date.now() ||
    config.expiryEpoch > Date.now() + 4 * 3600000
  )
    throw Error('Explicit expiry within four hours required');
  const publicOrigin = new URL(config.publicOrigin).origin;
  if (!publicOrigin.startsWith('https://'))
    throw Error('HTTPS public origin required');
  const authOrigin = new URL(config.authOrigin).origin;
  if (config.secret.length < 32 || config.password.length < 12)
    throw Error('Strong gateway secret and upstream password required');
  const sign = (value) =>
    createHmac('sha256', config.secret).update(value).digest('base64url');
  const valid = (raw) => {
    const found = (raw || '')
      .split(';')
      .map((x) => x.trim())
      .filter((x) => x.startsWith(cookieName + '='));
    if (found.length !== 1) return false;
    const [exp, nonce, mac, ...extra] = found[0]
      .slice(cookieName.length + 1)
      .split('.');
    return (
      !extra.length &&
      /^\d+$/.test(exp || '') &&
      Number(exp) > Date.now() &&
      Number(exp) <= Date.now() + 4 * 3600000 &&
      typeof nonce === 'string' &&
      typeof mac === 'string' &&
      safeEqual(sign(exp + '.' + nonce), mac)
    );
  };
  const limits = new Map();
  const server = http.createServer(async (req, res) => {
    if (Date.now() >= config.expiryEpoch) {
      res.writeHead(503);
      res.end('Synthetic staging test has expired.');
      return;
    }
    const deadline = setTimeout(
      () => res.destroy(),
      config.expiryEpoch - Date.now(),
    );
    deadline.unref();
    res.once('close', () => clearTimeout(deadline));
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    const send = (status, body, type = 'application/json') => {
      if (res.headersSent) return;
      res.writeHead(status, { 'content-type': type });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    const unavailable = () =>
      send(503, {
        code: 'staging-unavailable',
        detail: 'The short-lived staging service is unavailable or expired.',
      });
    const path = permittedPath(req.url);
    if (path === undefined) {
      send(404, { code: 'route-unavailable' });
      return;
    }
    const mutation = !['GET', 'HEAD'].includes(req.method);
    if (mutation && req.headers.origin !== publicOrigin) {
      send(403, { code: 'origin-rejected' });
      return;
    }
    const key = req.socket.remoteAddress;
    const now = Date.now();
    let rate = limits.get(key);
    if (!rate || now - rate.start > 60000) {
      rate = { start: now, total: 0, login: 0 };
      limits.set(key, rate);
    }
    rate.total++;
    if (limits.size > 1024)
      for (const [k, v] of limits) if (now - v.start > 60000) limits.delete(k);
    if (
      rate.total > 300 ||
      (path === '/preview/login' && mutation && ++rate.login > 10)
    ) {
      send(429, { code: 'rate-limited' });
      return;
    }
    if (path === '/preview/login' && req.method === 'GET') {
      send(200, html, 'text/html; charset=utf-8');
      return;
    }
    if (path === '/preview/logout' && req.method === 'POST') {
      res.setHeader(
        'Set-Cookie',
        `${cookieName}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
      );
      res.writeHead(303, { location: '/preview/login' });
      res.end();
      return;
    }
    const login = path === '/preview/login' && req.method === 'POST';
    if (!login && !valid(req.headers.cookie)) {
      if (path.startsWith('/api/')) send(401, { code: 'test-login-required' });
      else {
        res.writeHead(303, { location: '/preview/login' });
        res.end();
      }
      return;
    }
    const max = login ? 2048 : 20 * 1024 * 1024;
    if (Number(req.headers['content-length'] || 0) > max) {
      send(413, { code: 'body-too-large' });
      req.resume();
      return;
    }
    let body = Buffer.alloc(0);
    if (login) {
      try {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > max) {
            send(413, { code: 'body-too-large' });
            return;
          }
          chunks.push(chunk);
        }
        body = Buffer.concat(chunks);
      } catch {
        return;
      }
    }
    if (login) {
      if (
        !/^application\/x-www-form-urlencoded(?:;|$)/i.test(
          req.headers['content-type'] || '',
        )
      ) {
        send(415, { code: 'form-required' });
        return;
      }
      const form = new URLSearchParams(body.toString());
      if (
        form.getAll('username').length !== 1 ||
        form.getAll('password').length !== 1 ||
        !safeEqual(form.get('username') || '', 'test') ||
        !safeEqual(form.get('password') || '', 'test')
      ) {
        send(
          401,
          html.replace('<form', '<p>Incorrect test credentials.</p><form'),
          'text/html; charset=utf-8',
        );
        return;
      }
      body = Buffer.from(
        JSON.stringify({ email: config.email, password: config.password }),
      );
    }
    // Authentication entry points cannot bypass the explicit test login.
    if (
      !login &&
      /^\/api\/auth\/(sign-in|sign-up|request-password|reset-password)/.test(
        path,
      )
    ) {
      send(403, { code: 'use-test-login' });
      return;
    }
    const headers = {};
    for (const [name, value] of Object.entries(req.headers))
      if (
        !hop.has(name) &&
        ![
          'host',
          'content-length',
          'accept-encoding',
          'authorization',
          'x-forwarded-for',
          'x-forwarded-host',
          'x-forwarded-proto',
          'forwarded',
          'x-real-ip',
        ].includes(name)
      )
        headers[name] = value;
    if (/^\/powersync(?:\/|\?|$)/.test(req.url) && req.headers.authorization)
      headers.authorization = req.headers.authorization;
    headers.host = new URL(authOrigin).host;
    headers.origin = authOrigin;
    headers['accept-encoding'] = 'identity';
    if (login) headers['content-length'] = String(body.length);
    else if (req.headers['content-length'])
      headers['content-length'] = req.headers['content-length'];
    if (headers.cookie)
      headers.cookie = headers.cookie
        .split(';')
        .filter((x) => !x.trim().startsWith(cookieName + '='))
        .join(';');
    if (login) {
      delete headers.cookie;
      headers['content-type'] = 'application/json';
      headers['idempotency-key'] = 'preview-login:' + randomUUID();
    }
    const proxy = http.request(
      upstream,
      {
        method: login ? 'POST' : req.method,
        path: login ? '/api/auth/sign-in/email' : req.url,
        headers,
      },
      (response) => {
        const cookies = (response.headers['set-cookie'] || []).map(
          secureCookie,
        );
        if (login) {
          response.resume();
          if (
            response.statusCode >= 200 &&
            response.statusCode < 300 &&
            cookies.some((x) => x.startsWith('__Secure-emdo.session_token='))
          ) {
            const exp = String(
                Math.min(config.expiryEpoch, Date.now() + 4 * 3600000),
              ),
              nonce = randomUUID(),
              value = exp + '.' + nonce;
            cookies.push(
              `${cookieName}=${value}.${sign(value)}; Path=/; Max-Age=14400; HttpOnly; Secure; SameSite=Lax`,
            );
            res.setHeader('set-cookie', cookies);
            res.writeHead(303, { location: '/' });
            res.end();
          } else unavailable();
          return;
        }
        for (const [name, value] of Object.entries(response.headers))
          if (
            !hop.has(name) &&
            ![
              'set-cookie',
              'content-length',
              'content-encoding',
              'cache-control',
            ].includes(name) &&
            value !== undefined
          )
            res.setHeader(name, value);
        if (
          path === '/api/auth/sign-out' &&
          response.statusCode >= 200 &&
          response.statusCode < 300
        )
          cookies.push(
            `${cookieName}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
          );
        if (cookies.length) res.setHeader('set-cookie', cookies);
        if (response.headers.location?.startsWith(authOrigin))
          res.setHeader(
            'location',
            publicOrigin + response.headers.location.slice(authOrigin.length),
          );
        if ((response.headers['content-type'] || '').includes('text/html')) {
          let size = 0;
          const chunks = [];
          response.on('data', (chunk) => {
            size += chunk.length;
            if (size > 2 * 1024 * 1024) {
              response.destroy();
              unavailable();
            } else chunks.push(chunk);
          });
          response.on('end', () => {
            if (res.writableEnded) return;
            res.writeHead(response.statusCode);
            res.end(
              Buffer.concat(chunks)
                .toString()
                .replace(/<body([^>]*)>/i, `<body$1>${banner}`),
            );
          });
        } else {
          res.writeHead(response.statusCode);
          response.pipe(res);
        }
        response.on('error', () => {
          if (res.headersSent) res.destroy();
          else unavailable();
        });
      },
    );
    proxy.setTimeout(60000, () => proxy.destroy());
    proxy.on('error', unavailable);
    res.on('close', () => proxy.destroy());
    if (login) proxy.end(body);
    else {
      let size = 0;
      const bounded = new Transform({
        transform(chunk, encoding, callback) {
          size += chunk.length;
          if (size > max) {
            send(413, { code: 'body-too-large' });
            callback(Error('body-too-large'));
          } else callback(null, chunk);
        },
      });
      bounded.on('error', () => proxy.destroy());
      req.pipe(bounded).pipe(proxy);
    }
  });
  let sockets = 0;
  server.on('upgrade', (req, socket, head) => {
    if (
      permittedPath(req.url) === undefined ||
      Date.now() >= config.expiryEpoch ||
      !valid(req.headers.cookie) ||
      req.headers.origin !== publicOrigin ||
      !/^\/powersync(?:\/|\?|$)/.test(req.url) ||
      sockets >= 32
    ) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    sockets++;
    let counted = true;
    const done = () => {
      if (counted) {
        counted = false;
        sockets--;
      }
    };
    socket.once('close', done);
    const headers = {
      host: new URL(authOrigin).host,
      origin: authOrigin,
      connection: 'Upgrade',
      upgrade: 'websocket',
    };
    for (const name of [
      'sec-websocket-key',
      'sec-websocket-version',
      'sec-websocket-protocol',
      'sec-websocket-extensions',
      'authorization',
    ])
      if (req.headers[name]) headers[name] = req.headers[name];
    headers.cookie = (req.headers.cookie || '')
      .split(';')
      .filter((x) => !x.trim().startsWith(cookieName + '='))
      .join(';');
    const proxy = http.request(upstream, {
      method: 'GET',
      path: req.url,
      headers,
    });
    proxy.on('upgrade', (response, upstreamSocket, upstreamHead) => {
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
          Object.entries(response.headers)
            .map(([k, v]) => k + ': ' + v)
            .join('\r\n') +
          '\r\n\r\n',
      );
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) upstreamSocket.write(head);
      const expiry = setTimeout(
        () => {
          socket.destroy();
          upstreamSocket.destroy();
        },
        Math.min(
          config.expiryEpoch - Date.now(),
          4 * 3600000,
          Number(
            (req.headers.cookie || '')
              .split(';')
              .map((x) => x.trim())
              .find((x) => x.startsWith(cookieName + '='))
              .slice(cookieName.length + 1)
              .split('.')[0],
          ) - Date.now(),
        ),
      );
      expiry.unref();
      socket.on('close', () => {
        clearTimeout(expiry);
        upstreamSocket.destroy();
      });
      upstreamSocket.on('close', () => socket.destroy());
      socket.on('error', () => upstreamSocket.destroy());
      upstreamSocket.on('error', () => socket.destroy());
      socket.pipe(upstreamSocket).pipe(socket);
    });
    proxy.on('response', () => socket.destroy());
    proxy.on('error', () => socket.destroy());
    proxy.setTimeout(60000, () => proxy.destroy());
    proxy.end();
  });
  server.requestTimeout = 20000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 80;
  return server;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const path = process.env.PREVIEW_SECRET_FILE;
  const stat = statSync(path);
  if (
    !stat.isFile() ||
    ![0, process.getuid()].includes(stat.uid) ||
    stat.mode & 0o077
  )
    throw Error('Secret file must be service-owned or root-owned and private');
  const secrets = JSON.parse(readFileSync(path, 'utf8'));
  if (
    !Number.isFinite(secrets.expiryEpoch) ||
    secrets.expiryEpoch <= Date.now() ||
    secrets.expiryEpoch > Date.now() + 4 * 3600000
  )
    throw Error('Explicit future expiry within four hours required');
  createGateway({
    upstream: process.env.PREVIEW_UPSTREAM || 'http://127.0.0.1:18080',
    publicOrigin:
      process.env.PREVIEW_PUBLIC_ORIGIN || 'https://bot.32cbgg8.com',
    authOrigin: process.env.PREVIEW_AUTH_ORIGIN,
    ...secrets,
  }).listen(Number(process.env.PREVIEW_PORT || 18081), '127.0.0.1');
}
