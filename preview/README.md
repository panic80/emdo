# Short-lived real staging gateway

Node 22+ standard library only. All application/API responses originate from the real isolated staging service. No fake sessions, API fixtures, model responses, data files or provider configuration are created. Exact `test` / `test` form credentials are exchanged for the existing synthetic owner's real backend session. All HTTP and PowerSync WebSocket access requires an additional signed test-access cookie. Backend session/CSRF checks remain authoritative. The HTML banner identifies synthetic staging.

Copy server.mjs to `/opt/emdo-preview/server.mjs`, install the unit template after reviewing paths, and supply root-owned mode-0600 `/etc/emdo/preview.json`:

```json
{
  "email": "EXISTING_SYNTHETIC_OWNER_EMAIL",
  "password": "EXISTING_STRONG_SYNTHETIC_OWNER_PASSWORD",
  "secret": "RANDOM_AT_LEAST_32_CHARACTERS",
  "expiryEpoch": 0
}
```

Replace expiryEpoch with the governed staging deadline as epoch milliseconds, future and at most four hours away. Obtain only the existing synthetic owner email/password from the protected staging configuration; never use production credentials. Generate secret with cryptographic randomness. systemd LoadCredential exposes a private copy to DynamicUser. No credentials are logged.

Environment: PREVIEW_UPSTREAM=http://127.0.0.1:18080 (fixed loopback transport), PREVIEW_PUBLIC_ORIGIN=https://bot.32cbgg8.com, PREVIEW_AUTH_ORIGIN=https://staging.emdo.invalid (backend Host/Origin), PREVIEW_PORT=18081, PREVIEW_SECRET_FILE supplied by unit. Listener is always 127.0.0.1. Outer Nginx must proxy to it with WebSocket Upgrade headers and buffering disabled, preserving `/pos` separately. The upstream must not be publicly reachable through another route.

Login `/preview/login`; POST `/preview/logout` clears gateway access. Actual app sign-out also clears it following successful backend sign-out. Cookies are host-scoped and Secure; browser use requires HTTPS. Mutations validate exact public Origin before backend rewrite. Real document uploads are passed through with a 20 MiB cap: use synthetic test files only. This banner is an instruction, not content inspection. Ordinary HTTP requests stream, including SSE; request body cap is enforced while streaming, so backend may receive a prefix before oversized chunked requests are cut off. Internal/metrics/health/readiness routes are blocked. PowerSync upgrades are limited to 32 concurrent sockets and the earliest cookie/staging expiry. API availability, actual model execution and supported features are entirely staging-dependent. Upstream timeouts return 503 before response headers; interrupted streams close.

Validate locally: `node --test preview/gateway.test.mjs`. Tests use a loopback transport stub; they do not prove deployed backend readiness, PowerSync synchronization, model output or UI functionality. This directory makes no VPS changes itself.
