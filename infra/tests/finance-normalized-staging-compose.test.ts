import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
const root = fileURLToPath(new URL('../../', import.meta.url));
const files = [
  'compose.yml',
  'compose.staging.yml',
  'compose.finance-staging.yml',
  'compose.finance-normalized-staging.yml',
];
const available =
  spawnSync('docker', ['compose', 'version'], {
    stdio: 'ignore',
    timeout: 5000,
  }).status === 0;
it.skipIf(!available)(
  'merges normalized staging credentials, feature flags, networks and acceptance without dropping legacy API env files',
  () => {
    const temporary = mkdtempSync(join(tmpdir(), 'emdo-normalized-compose-'));
    try {
      const environment: Record<string, string> = {};
      for (const file of files) {
        const source = readFileSync(join(root, 'infra/compose', file), 'utf8');
        for (const [, filename] of source.matchAll(/\/([\w-]+\.env)/g))
          writeFileSync(join(temporary, filename!), '');
        for (const [, key] of source.matchAll(/\$\{([A-Z_][A-Z_0-9]*)/g)) {
          environment[key!] = key!.endsWith('_IMAGE')
            ? `synthetic.invalid/app@sha256:${'a'.repeat(64)}`
            : key === 'STAGING_HTTP_PORT'
              ? '18080'
              : key!.endsWith('_DIR')
                ? temporary
                : key!.endsWith('_FILE')
                  ? join(temporary, key!)
                  : 'synthetic';
          if (key!.endsWith('_FILE')) writeFileSync(environment[key!]!, '');
        }
      }
      environment.EMDO_FINANCE_NORMALIZED_SYNTHETIC_STAGING = 'true';
      writeFileSync(join(temporary, 'api.env'), 'SYNTHETIC_BASE_API=present\n');
      writeFileSync(
        join(temporary, 'edge-proxy.env'),
        'SYNTHETIC_EDGE=present\n',
      );
      writeFileSync(
        join(temporary, 'worker.env'),
        'SYNTHETIC_BASE_WORKER=present\n',
      );
      writeFileSync(
        environment.FINANCE_STAGING_API_ENV_FILE!,
        'SYNTHETIC_LEGACY_FINANCE=present\n',
      );
      writeFileSync(
        environment.FINANCE_NORMALIZED_STAGING_API_ENV_FILE!,
        'SYNTHETIC_NORMALIZED_API=present\n',
      );
      writeFileSync(
        environment.FINANCE_NORMALIZED_STAGING_WORKER_ENV_FILE!,
        'SYNTHETIC_NORMALIZED_WORKER=present\n',
      );
      const result = spawnSync(
        'docker',
        [
          'compose',
          ...files.flatMap((f) => ['-f', `infra/compose/${f}`]),
          '--profile',
          'operations',
          'config',
          '--format',
          'json',
        ],
        {
          cwd: root,
          encoding: 'utf8',
          timeout: 15000,
          env: { ...process.env, ...environment },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      const config = JSON.parse(result.stdout);
      const steadyStateBytes = Object.values(
        config.services as Record<
          string,
          {
            profiles?: string[];
            deploy: { resources: { limits: { memory: string } } };
          }
        >,
      )
        .filter((service) => !service.profiles?.length)
        .reduce(
          (total, service) =>
            total + Number(service.deploy.resources.limits.memory),
          0,
        );
      expect(steadyStateBytes / 1024 / 1024).toBe(2080);
      expect(
        (steadyStateBytes +
          Number(
            config.services['staging-acceptance'].deploy.resources.limits
              .memory,
          )) /
          1024 /
          1024,
      ).toBe(2272);
      expect(config.services.api.environment.SYNTHETIC_BASE_API).toBe(
        'present',
      );
      expect(config.services.api.environment.SYNTHETIC_EDGE).toBe('present');
      expect(config.services.api.environment.SYNTHETIC_LEGACY_FINANCE).toBe(
        'present',
      );
      expect(config.services.api.environment.SYNTHETIC_NORMALIZED_API).toBe(
        'present',
      );
      expect(
        config.services.worker.environment.SYNTHETIC_NORMALIZED_WORKER,
      ).toBe('present');
      expect(
        config.services.worker.environment.SYNTHETIC_BASE_WORKER,
      ).toBeUndefined();
      expect(Object.keys(config.services.worker.networks).sort()).toEqual([
        'backend',
        'finance-normalized-egress',
      ]);
      expect(
        config.networks['finance-normalized-egress'].internal ?? false,
      ).toBe(false);
      expect(
        config.services.worker.environment.EMDO_FINANCE_STANDARDIZATION_ENABLED,
      ).toBe('true');
      expect(
        config.services.api.environment.EMDO_FINANCE_STANDARDIZATION_ENABLED,
      ).toBe('true');
      expect(config.services['staging-acceptance'].command).toContain(
        '--finance-normalized-synthetic-gates',
      );
      expect(config.services['staging-acceptance'].command).not.toContain(
        '--forbid-worker-provider-execution',
      );
      expect(config.services['synthetic-data'].command).toContain(
        '--finance-normalized-synthetic-gates',
      );
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  },
);
