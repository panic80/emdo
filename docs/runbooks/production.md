# Production release

Production accepts only the exact digests and source commit that passed staging.
GitHub's protected `production` environment supplies the approval and secrets.

1. Verify the staging acceptance artifact and digest set.
2. Create a Hostinger manual snapshot and wait for provider-confirmed
   completion.
3. Run an encrypted logical backup and verify its age and checksum.
4. Manually approve the protected production workflow.
5. Apply only backward-compatible migrations and pg-boss schema provisioning.
6. Start the exact image digests and require API, worker, PostgreSQL,
   PowerSync, web, and Caddy readiness.
7. Promote the deployment lock only after health checks complete.

If health fails, retain the pending deployment record and use the protected
rollback path. Do not reverse SQL. If the previous image is incompatible with
the current schema, choose a forward fix or an explicitly authorized outage
restore.

## Shared host Nginx (opt-in)

The default topology remains public Caddy. A host already serving other apps
must instead use `EMDO_INGRESS_MODE=shared-nginx` in the root-owned production
`deployment.env`, with `EMDO_NGINX_TRUSTED_PEER` set to the **single observed
private IPv4 socket peer** of host Nginx as seen by the Caddy container. This
is commonly a Docker bridge gateway; inspect the actual network/connection,
do not assume `127.0.0.1`. CIDRs, hostnames, public addresses and lists are
rejected. Reserve that bridge address across container recreation. An incorrect
peer fails closed with HTTP 403. The overlay replaces public ports with
`127.0.0.1:18081:8080`; it never takes host ports 80 or 443.

Keep the existing Nginx TLS server and every adjacent application location.
Add the following catch-all only after checking existing route precedence;
retain `/pos` and `/pos/` handling and any regex locations they require. Define
`map $http_upgrade $emdo_connection_upgrade { default upgrade; '' close; }`
in Nginx's `http` context once. Inside the existing TLS server:

```nginx
location / {
    proxy_pass http://127.0.0.1:18081;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header Forwarded "";
    proxy_set_header X-Real-IP "";
    proxy_set_header X-Emdo-Edge-Proxy "";
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $emdo_connection_upgrade;
    proxy_buffering off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    client_max_body_size 20m;
}
```

Nginx overwrites client identity; Caddy trusts only the configured socket peer,
rejects other peers, resolves the client IP and injects its private edge proof.
Caddy explicitly forwards HTTPS to the API and PowerSync even though its
internal listener is HTTP. Public origin, Google callback URLs and PowerSync
JWKS must retain the public HTTPS hostname. TLS certificates remain owned by
host Nginx. Do not put a proxy/CDN ahead of Nginx without separately reviewing
its client-IP boundary.

Run `nginx -t` before a reload. Verify retained app routes, EMDO authentication,
SSE, PowerSync WebSocket traffic, `/metrics` returning 404, secure cookies,
and client-IP spoof rejection through public HTTPS. Root-scoped EMDO service
worker navigation handling must exclude adjacent applications such as `/pos`
and `/pos/` before enabling EMDO on the shared origin; host routing cannot
prevent a browser service worker from returning its offline fallback.

This overlay and Caddy configuration are release infrastructure: include them
in reviewed/signed deployment assets and staging evidence. Existing production
archive equality gates still apply. A change from direct ingress requires an
explicit infrastructure migration; ordinary application promotion cannot
silently change topology. No production readiness requirements are weakened.
