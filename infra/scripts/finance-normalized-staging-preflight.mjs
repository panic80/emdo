import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { pathToFileURL } from 'node:url';

const fail = (code) => {
  throw new Error(code);
};
const requiredFlags = {
  EMDO_ENVIRONMENT: 'staging',
  EMDO_SYNTHETIC_DATA_ONLY: 'true',
  EMDO_FINANCE_SYNTHETIC_STAGING: 'true',
  EMDO_FINANCE_NORMALIZED_SYNTHETIC_STAGING: 'true',
  EMDO_FINANCE_V2_ENABLED: 'true',
  EMDO_FINANCE_STANDARDIZATION_ENABLED: 'true',
  EMDO_FINANCE_SCHEDULES_ENABLED: 'false',
  EMDO_EXTERNAL_PROVIDERS_ENABLED: 'false',
};
function database(value, identity) {
  try {
    const url = new URL(value);
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !url.hostname ||
      url.pathname.length < 2 ||
      url.hash ||
      (identity
        ? decodeURIComponent(url.username) !== identity || !url.password
        : url.username || url.password) ||
      [...url.searchParams.keys()].some(
        (key) =>
          !['sslmode', 'application_name', 'connect_timeout'].includes(key),
      )
    )
      throw new Error();
    return `${url.hostname.toLowerCase()}:${url.port || '5432'}${url.pathname}`;
  } catch {
    fail('normalized-preflight-database-invalid');
  }
}
function keyring(encoded) {
  try {
    if (
      typeof encoded !== 'string' ||
      encoded.length > 8192 ||
      !/^[A-Za-z0-9_-]+$/.test(encoded)
    )
      throw new Error();
    const raw = Buffer.from(encoded, 'base64url');
    if (raw.length > 6144 || raw.toString('base64url') !== encoded)
      throw new Error();
    let value;
    try {
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
    } finally {
      raw.fill(0);
    }
    if (
      Object.keys(value).sort().join() !== 'current,previous,schemaVersion' ||
      value.schemaVersion !== 1 ||
      !Array.isArray(value.previous) ||
      value.previous.length > 2
    )
      throw new Error();
    const entries = [value.current, ...value.previous];
    for (const entry of entries) {
      if (
        Object.keys(entry).sort().join() !== 'keyB64url,keyVersion' ||
        typeof entry.keyVersion !== 'string' ||
        entry.keyVersion.length > 64 ||
        !/^finance-documents\.v[1-9][0-9]*$/.test(entry.keyVersion) ||
        typeof entry.keyB64url !== 'string' ||
        !/^[A-Za-z0-9_-]{43}$/.test(entry.keyB64url)
      )
        throw new Error();
      const bytes = Buffer.from(entry.keyB64url, 'base64url');
      try {
        if (
          bytes.length !== 32 ||
          bytes.toString('base64url') !== entry.keyB64url
        )
          throw new Error();
      } finally {
        bytes.fill(0);
      }
    }
    if (
      new Set(entries.map((e) => e.keyVersion)).size !== entries.length ||
      new Set(entries.map((e) => e.keyB64url)).size !== entries.length
    )
      throw new Error();
    return JSON.stringify({ current: value.current, previous: value.previous });
  } catch {
    fail('normalized-preflight-keyring-invalid');
  }
}
/**
 * Inputs are COMPLETE EFFECTIVE API/worker environments after Compose overlays.
 * Passing the additional normalized API env_file alone deliberately fails.
 * Static configuration validation only: no database or provider connections;
 * fixed Astra/medium selection comes from durable-finance-standardization.ts.
 * Success does not verify database grants, provider validity or pricing accuracy.
 */
export function validateNormalizedStagingEnvironment(
  api,
  worker,
  intendedDatabaseTarget,
) {
  for (const env of [api, worker]) {
    if (
      Object.entries(requiredFlags).some(([key, value]) => env[key] !== value)
    )
      fail('normalized-preflight-flags-invalid');
    if (env.EMDO_FINANCE_SCHEDULER_DATABASE_URL)
      fail('normalized-preflight-scheduler-credentials-forbidden');
  }
  const target = database(intendedDatabaseTarget);
  for (const [env, key, identity] of [
    [api, 'EMDO_API_DATABASE_URL', 'emdo_api_login'],
    [worker, 'EMDO_WORKER_DATABASE_URL', 'emdo_worker_login'],
    [worker, 'EMDO_WORKER_EXECUTOR_DATABASE_URL', 'emdo_worker_executor_login'],
    [
      worker,
      'EMDO_WORKER_DISPATCHER_DATABASE_URL',
      'emdo_worker_dispatcher_login',
    ],
  ])
    if (database(env[key], identity) !== target)
      fail('normalized-preflight-database-target-mismatch');
  if (
    keyring(api.EMDO_FINANCE_DOCUMENT_KEYRING_B64URL) !==
    keyring(worker.EMDO_FINANCE_DOCUMENT_KEYRING_B64URL)
  )
    fail('normalized-preflight-keyring-mismatch');
  if (
    !worker.EMDO_OPENAI_AGENT_API_KEY?.trim() ||
    !worker.EMDO_OPENAI_AGENT_PRICING_VERSION?.trim() ||
    worker.EMDO_OPENAI_AGENT_PRICING_VERSION.length > 128
  )
    fail('normalized-preflight-provider-config-incomplete');
  for (const direction of ['INPUT', 'OUTPUT']) {
    const value =
      worker[
        `EMDO_OPENAI_AGENT_GPT_6_ASTRA_${direction}_CAD_MINOR_PER_MILLION_TOKENS`
      ];
    if (!value || !Number.isSafeInteger(Number(value)) || Number(value) <= 0)
      fail('normalized-preflight-pricing-invalid');
  }
  return {
    status: 'valid',
    scope: 'static-configuration-only',
    model: 'gpt-6-astra',
    reasoningEffort: 'medium',
  };
}
export async function readPrivateEnvironment(path) {
  if (!isAbsolute(path)) fail('normalized-preflight-absolute-path-required');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.size > 65536 ||
      (stat.mode & 0o077) !== 0 ||
      stat.uid !== process.getuid()
    )
      fail('normalized-preflight-private-file-required');
    const contents = await file.readFile('utf8');
    // Use literal env assignments: Compose interpolation and shell evaluation are forbidden.
    if (
      contents.includes('$') ||
      contents
        .split(/\r?\n/)
        .some(
          (line) =>
            line.trim() &&
            !line.trim().startsWith('#') &&
            !/^[A-Z][A-Z0-9_]*=[^\r\n]*$/.test(line),
        )
    )
      fail('normalized-preflight-env-format-invalid');
    const names = contents
      .split(/\r?\n/)
      .filter((line) => /^[A-Z]/.test(line))
      .map((line) => line.split('=', 1)[0]);
    if (new Set(names).size !== names.length)
      fail('normalized-preflight-env-duplicate');
    return parseEnv(contents);
  } finally {
    await file.close();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const [a, apiPath, b, workerPath, c, target, ...extra] =
      process.argv.slice(2);
    if (
      a !== '--api-env' ||
      b !== '--worker-env' ||
      c !== '--database-target' ||
      !apiPath ||
      !workerPath ||
      !target ||
      extra.length ||
      resolve(apiPath) === resolve(workerPath)
    )
      fail('normalized-preflight-arguments-invalid');
    const api = await readPrivateEnvironment(apiPath);
    const worker = await readPrivateEnvironment(workerPath);
    process.stdout.write(
      `${JSON.stringify(validateNormalizedStagingEnvironment(api, worker, target))}\n`,
    );
  } catch (error) {
    const code =
      error instanceof Error &&
      /^normalized-preflight-[a-z-]+$/.test(error.message)
        ? error.message
        : 'normalized-preflight-input-invalid';
    process.stderr.write(`${JSON.stringify({ status: 'invalid', code })}\n`);
    process.exitCode = 1;
  }
}
