import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const run = (mode: string, peer = '') =>
  spawnSync(
    'bash',
    [
      '-c',
      'source infra/scripts/_common.sh; docker() { printf "%s\\n" "$@"; }; production_compose config --quiet',
    ],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        EMDO_COMMON_SH_LOADED: '',
        EMDO_INGRESS_MODE: mode,
        EMDO_NGINX_TRUSTED_PEER: peer,
      },
    },
  );

describe('shared Nginx production ingress', () => {
  it('preserves default Compose and selects the overlay only explicitly', () => {
    const direct = run('direct');
    expect(direct.status).toBe(0);
    expect(direct.stdout).not.toContain('compose.shared-nginx.yml');
    const shared = run('shared-nginx', '172.19.0.1');
    expect(shared.status).toBe(0);
    expect(shared.stdout).toContain('compose.shared-nginx.yml');
    expect(shared.stdout).toContain('config\n--quiet');
  });
  it.each([
    '',
    '0.0.0.0/0',
    '172.16.0.0/12',
    'private_ranges',
    '8.8.8.8',
    '172.19.0.256',
    '172.019.0.1',
    '127.0.0.1 10.0.0.1',
    'localhost',
    '172.19.0.1\nadmin off',
  ])('rejects unsafe or ambiguous peer %j before Docker', (peer) => {
    const result = run('shared-nginx', peer);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
  });
  it('rejects unknown topology and orphaned trust configuration', () => {
    expect(run('typo', '172.19.0.1').status).not.toBe(0);
    expect(run('direct', '172.19.0.1').status).not.toBe(0);
  });
  it('keeps loopback-only ingress, proof injection, HTTPS forwarding and streaming', () => {
    const overlay = readFileSync(
      `${root}/infra/compose/compose.shared-nginx.yml`,
      'utf8',
    );
    const caddy = readFileSync(
      `${root}/infra/caddy/Caddyfile.shared-nginx`,
      'utf8',
    );
    expect(overlay).toContain(
      "ports: !override\n      - '127.0.0.1:18081:8080'",
    );
    expect(caddy).toContain(
      '@untrusted not remote_ip {$EMDO_NGINX_TRUSTED_PEER}',
    );
    expect(caddy).toContain('respond @untrusted 403');
    expect(caddy.match(/header_up X-Emdo-Edge-Proxy/gu)).toHaveLength(3);
    expect(
      caddy.match(/header_up X-Forwarded-For \{client_ip\}/gu),
    ).toHaveLength(3);
    expect(caddy.match(/header_up X-Forwarded-Proto https/gu)).toHaveLength(4);
    expect(caddy).toContain('flush_interval -1');
    expect(caddy).toContain('respond 404');
    execFileSync('bash', ['-n', 'infra/scripts/_common.sh'], { cwd: root });
  });
});
