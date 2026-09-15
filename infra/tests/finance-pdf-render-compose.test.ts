import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const files = [
  'compose.yml',
  'compose.staging.yml',
  'compose.finance-staging.yml',
  'compose.finance-ocr.yml',
  'compose.finance-pdf-render.yml',
];
const dockerAvailable =
  spawnSync('docker', ['compose', 'version'], {
    timeout: 5000,
    stdio: 'ignore',
  }).status === 0;
const temporary = mkdtempSync(join(tmpdir(), 'emdo-pdf-compose-'));
afterAll(() => rmSync(temporary, { recursive: true, force: true }));
for (const file of files)
  for (const match of readFileSync(
    `${root}/infra/compose/${file}`,
    'utf8',
  ).matchAll(/\/([\w-]+\.env)/g))
    writeFileSync(join(temporary, match[1]!), '');
const syntheticEnvironment = Object.fromEntries(
  files.flatMap((file) =>
    [
      ...readFileSync(`${root}/infra/compose/${file}`, 'utf8').matchAll(
        /\$\{([A-Z_][A-Z_0-9]*)/g,
      ),
    ].map((match) => {
      const key = match[1]!;
      const value = key.endsWith('_IMAGE')
        ? `synthetic.invalid/helper@sha256:${'a'.repeat(64)}`
        : key === 'STAGING_HTTP_PORT'
          ? '18080'
          : key.endsWith('_DIR') || key.endsWith('_FILE')
            ? key.endsWith('_DIR')
              ? temporary
              : join(temporary, key)
            : 'synthetic';
      return [key, value];
    }),
  ),
);
for (const [key, value] of Object.entries(syntheticEnvironment))
  if (key.endsWith('_FILE')) writeFileSync(value, '');
const config = (selected = files) =>
  spawnSync(
    'docker',
    [
      'compose',
      ...selected.flatMap((file) => ['-f', `infra/compose/${file}`]),
      '--profile',
      'finance-ocr',
      '--profile',
      'finance-pdf-render',
      'config',
      '--no-env-resolution',
      '--format',
      'json',
    ],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 15000,
      env: { ...process.env, ...syntheticEnvironment },
    },
  );

describe('opt-in private staging PDF renderer', () => {
  it('keeps defaults disabled and socket permission ownership fixed', async () => {
    const [base, dockerfile, supervisor, overlay] = await Promise.all(
      [
        'infra/compose/compose.yml',
        'infra/finance-pdf-render/Dockerfile',
        'infra/finance-pdf-render/socket-server.mjs',
        'infra/compose/compose.finance-pdf-render.yml',
      ].map((path) => readFile(`${root}/${path}`, 'utf8')),
    );
    expect(base).not.toContain('EMDO_FINANCE_PDF_RENDER_TRANSPORT');
    expect(base).not.toContain('finance-pdf-render-socket');
    expect(dockerfile).toContain(
      'chown 10005:10005 /run/emdo/finance-pdf-render',
    );
    expect(dockerfile).toContain('chmod 0770 /run/emdo/finance-pdf-render');
    expect(supervisor).toMatch(/chmod\(\s*path\s*,\s*0o660\s*\)/);
    expect(overlay).toContain('FINANCE_PDF_RENDER_IMAGE:?');
    expect(overlay).toContain('STAGING_RUN_ID:?');
    expect(overlay).not.toContain('docker.sock');
    expect(overlay).not.toContain('env_file:');
    expect(overlay).not.toContain('secrets:');
  });

  it.skipIf(!dockerAvailable)(
    'merges isolated renderer with both application socket clients and the existing OCR gate',
    () => {
      const result = config();
      expect(result.status, result.stderr).toBe(0);
      const resolved = JSON.parse(result.stdout);
      const helper = resolved.services['finance-pdf-render'];
      expect(helper).toMatchObject({
        user: '10005:10005',
        network_mode: 'none',
        read_only: true,
        restart: 'no',
        cap_drop: ['ALL'],
        security_opt: ['no-new-privileges:true'],
        pids_limit: 32,
        deploy: {
          resources: { limits: { memory: '268435456', cpus: 1, pids: 32 } },
        },
      });
      expect(helper.profiles).toEqual(['finance-pdf-render']);
      expect(helper.env_file).toBeUndefined();
      expect(helper.secrets).toBeUndefined();
      expect(helper.environment).toBeUndefined();
      expect(helper.ports).toBeUndefined();
      expect(helper.networks).toBeUndefined();
      expect(helper.volumes).toHaveLength(1);
      expect(helper.volumes[0]).toMatchObject({
        type: 'volume',
        source: 'finance-pdf-render-socket',
        target: '/run/emdo/finance-pdf-render',
      });
      for (const name of ['api', 'worker']) {
        const app = resolved.services[name];
        expect(app.group_add).toContain('10005');
        expect(app.volumes).toContainEqual(
          expect.objectContaining({
            source: 'finance-pdf-render-socket',
            target: '/run/emdo/finance-pdf-render',
            read_only: true,
          }),
        );
        expect(app.depends_on['finance-pdf-render'].condition).toBe(
          'service_healthy',
        );
      }
      const worker = resolved.services.worker;
      expect(worker.group_add).toContain('10004');
      expect(worker.environment).toMatchObject({
        EMDO_FINANCE_IMAGE_OCR_TRANSPORT: 'unix-socket',
        EMDO_FINANCE_PDF_RENDER_TRANSPORT: 'unix-socket',
      });
      expect(worker.volumes).toContainEqual(
        expect.objectContaining({
          source: 'finance-ocr-socket',
          read_only: true,
        }),
      );
      expect(worker.depends_on['finance-ocr'].condition).toBe(
        'service_started',
      );
    },
  );

  it.skipIf(!dockerAvailable)(
    'rejects a missing OCR overlay instead of silently enabling local OCR',
    () => {
      const result = config(
        files.filter((file) => file !== 'compose.finance-ocr.yml'),
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('finance-ocr');
    },
  );
});
