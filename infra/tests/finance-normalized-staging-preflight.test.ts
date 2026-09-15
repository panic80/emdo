import { spawnSync } from 'node:child_process';
import {
  mkdtemp,
  writeFile,
  rm,
  chmod,
  symlink,
  readFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createFinanceDocumentKeyProvider } from '../../packages/integrations/src/finance-documents/keyring.js';

const script = fileURLToPath(
  new URL(
    '../scripts/finance-normalized-staging-preflight.mjs',
    import.meta.url,
  ),
);
const target = 'postgresql://postgres:5432/emdo_staging_run';
const shared = {
  EMDO_ENVIRONMENT: 'staging',
  EMDO_SYNTHETIC_DATA_ONLY: 'true',
  EMDO_FINANCE_SYNTHETIC_STAGING: 'true',
  EMDO_FINANCE_NORMALIZED_SYNTHETIC_STAGING: 'true',
  EMDO_FINANCE_V2_ENABLED: 'true',
  EMDO_FINANCE_STANDARDIZATION_ENABLED: 'true',
  EMDO_FINANCE_SCHEDULES_ENABLED: 'false',
  EMDO_EXTERNAL_PROVIDERS_ENABLED: 'false',
  EMDO_FINANCE_DOCUMENT_KEYRING_B64URL: Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      current: {
        keyVersion: 'finance-documents.v1',
        keyB64url: Buffer.alloc(32, 7).toString('base64url'),
      },
      previous: [],
    }),
  ).toString('base64url'),
};
const db = (role: string) =>
  `postgresql://${role}:SECRET_SENTINEL@postgres:5432/emdo_staging_run`;
const api = { ...shared, EMDO_API_DATABASE_URL: db('emdo_api_login') };
const worker = {
  ...shared,
  EMDO_WORKER_DATABASE_URL: db('emdo_worker_login'),
  EMDO_WORKER_EXECUTOR_DATABASE_URL: db('emdo_worker_executor_login'),
  EMDO_WORKER_DISPATCHER_DATABASE_URL: db('emdo_worker_dispatcher_login'),
  EMDO_OPENAI_AGENT_API_KEY: 'SECRET_SENTINEL',
  EMDO_OPENAI_AGENT_PRICING_VERSION: 'synthetic-test-only',
  EMDO_OPENAI_AGENT_GPT_6_ASTRA_INPUT_CAD_MINOR_PER_MILLION_TOKENS: '100',
  EMDO_OPENAI_AGENT_GPT_6_ASTRA_OUTPUT_CAD_MINOR_PER_MILLION_TOKENS: '200',
};
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture(
  a: Record<string, string> = api,
  w: Record<string, string> = worker,
) {
  const dir = await mkdtemp(join(tmpdir(), 'emdo-preflight-'));
  directories.push(dir);
  const paths = [join(dir, 'api.env'), join(dir, 'worker.env')];
  for (const [index, env] of [a, w].entries())
    await writeFile(
      paths[index]!,
      Object.entries(env)
        .map(([k, v]) => `${k}=${v}`)
        .join('\n'),
      { mode: 0o600 },
    );
  return paths;
}
function run(paths: string[], databaseTarget = target) {
  return spawnSync(
    process.execPath,
    [
      script,
      '--api-env',
      paths[0]!,
      '--worker-env',
      paths[1]!,
      '--database-target',
      databaseTarget,
    ],
    { encoding: 'utf8' },
  );
}
function rejected(result: ReturnType<typeof run>) {
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).not.toContain('SECRET_SENTINEL');
  expect(result.stderr).not.toContain('postgresql://');
  expect(JSON.parse(result.stderr).status).toBe('invalid');
}
describe('normalized staging static environment preflight', () => {
  it('accepts matching restricted identities and a keyring accepted by the production loader', async () => {
    createFinanceDocumentKeyProvider(
      shared.EMDO_FINANCE_DOCUMENT_KEYRING_B64URL,
    ).dispose();
    const result = run(await fixture());
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      status: 'valid',
      scope: 'static-configuration-only',
      model: 'gpt-6-astra',
      reasoningEffort: 'medium',
    });
    const hook = await readFile(
      new URL(
        '../../packages/agent-core/src/durable-finance-standardization.ts',
        import.meta.url,
      ),
      'utf8',
    );
    expect(hook).toContain("const MODEL = 'gpt-6-astra'");
    expect(hook).toContain("reasoningEffort: 'medium'");
  });
  it.each(
    Object.keys(shared).filter(
      (key) => key !== 'EMDO_FINANCE_DOCUMENT_KEYRING_B64URL',
    ),
  )('rejects a missing or unsafe effective flag %s', async (key) => {
    rejected(run(await fixture({ ...api, [key]: '' })));
    rejected(run(await fixture(api, { ...worker, [key]: 'unsafe' })));
  });
  it.each([
    { EMDO_WORKER_EXECUTOR_DATABASE_URL: db('postgres') },
    { EMDO_WORKER_DISPATCHER_DATABASE_URL: db('emdo_worker_executor_login') },
    {
      EMDO_WORKER_DATABASE_URL: db('emdo_worker_login').replace(
        'emdo_staging_run',
        'production',
      ),
    },
    {
      EMDO_WORKER_DATABASE_URL: `${db('emdo_worker_login')}?options=-cSECRET_SENTINEL`,
    },
    { EMDO_FINANCE_DOCUMENT_KEYRING_B64URL: 'SECRET_SENTINEL' },
    { EMDO_OPENAI_AGENT_API_KEY: '' },
    { EMDO_OPENAI_AGENT_PRICING_VERSION: '' },
    { EMDO_OPENAI_AGENT_GPT_6_ASTRA_INPUT_CAD_MINOR_PER_MILLION_TOKENS: '0' },
    {
      EMDO_OPENAI_AGENT_GPT_6_ASTRA_OUTPUT_CAD_MINOR_PER_MILLION_TOKENS: 'NaN',
    },
    { EMDO_FINANCE_SCHEDULER_DATABASE_URL: db('emdo_finance_scheduler_login') },
  ])(
    'rejects unsafe credentials/config without disclosing values %#',
    async (patch) => {
      rejected(
        run(
          await fixture(api, { ...worker, ...patch } as Record<string, string>),
        ),
      );
    },
  );
  it('rejects a different valid keyring', async () => {
    const value = JSON.parse(
      Buffer.from(
        shared.EMDO_FINANCE_DOCUMENT_KEYRING_B64URL,
        'base64url',
      ).toString(),
    );
    value.current.keyB64url = Buffer.alloc(32, 8).toString('base64url');
    rejected(
      run(
        await fixture(api, {
          ...worker,
          EMDO_FINANCE_DOCUMENT_KEYRING_B64URL: Buffer.from(
            JSON.stringify(value),
          ).toString('base64url'),
        }),
      ),
    );
  });
  it('rejects shared, public, symlinked, duplicate, interpolated and missing inputs safely', async () => {
    const paths = await fixture();
    rejected(run([paths[0]!, paths[0]!]));
    await chmod(paths[0]!, 0o644);
    rejected(run(paths));
    await chmod(paths[0]!, 0o600);
    const link = `${paths[0]}.link`;
    await symlink(paths[0]!, link);
    rejected(run([link, paths[1]!]));
    await writeFile(paths[0]!, 'KEY=SECRET_SENTINEL\nKEY=duplicate');
    rejected(run(paths));
    await writeFile(paths[0]!, 'KEY=${SECRET_SENTINEL}');
    rejected(run(paths));
    rejected(run([`${paths[0]}.missing`, paths[1]!]));
    rejected(run(await fixture(), db('postgres')));
  });
});
