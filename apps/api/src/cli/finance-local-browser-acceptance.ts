/** Disposable synthetic local browser fixture. Never accepts a remote database. */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer as createNetServer } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { createServer } from 'node:https';
import { request as httpRequest } from 'node:http';
import pg from 'pg';
import { hashPassword } from 'better-auth/crypto';
import {
  PostgresFinanceAutomationRepository,
  PostgresFinanceScheduleRepository,
  PostgresFinanceGeneratedReportRepository,
  PostgresFinanceV2Repository,
  PostgresFinanceStandardizationRepository,
} from '@emdo/db/api';
import {
  FinanceBookEvidenceCrypto,
  EncryptedFinanceBookEvidenceSchema,
} from '@emdo/integrations/finance-documents';
import { InMemoryVaultKeyProvider } from '../../../../packages/integrations/src/vault/crypto.js';
import { createProductionAuthenticationServiceBinding } from '../production/auth-services.js';
import { createFailClosedApiServices } from '../production/unavailable-services.js';
import { createApp } from '../app.js';

const directory = process.env.FINANCE_LOCAL_DIRECTORY!;
const target = new URL(process.env.FINANCE_LOCAL_DATABASE_URL!);
if (
  target.hostname !== '127.0.0.1' ||
  target.pathname !== '/emdo_app' ||
  process.env.FINANCE_LOCAL_CONTAINER_ATTESTED !== 'true' ||
  !directory
)
  throw new Error('isolated-local-container-attestation-required');
const admin = new pg.Pool({ connectionString: target.toString() });
const journal = JSON.parse(
  await readFile('packages/db/drizzle/meta/_journal.json', 'utf8'),
);
if (journal.entries.length !== 77) throw new Error('expected-77-migrations');
for (const { tag } of journal.entries) {
  await admin.query('begin');
  try {
    await admin.query(await readFile(`packages/db/drizzle/${tag}.sql`, 'utf8'));
    await admin.query('commit');
  } catch (error) {
    await admin.query('rollback');
    throw error;
  }
}
const rolePassword = randomBytes(32).toString('hex');
for (const [login, role] of [
  ['emdo_api_login', 'emdo_app'],
  ['emdo_auth_login', 'emdo_auth'],
]) {
  await admin.query(
    `create role ${login} login inherit nosuperuser nobypassrls nocreatedb nocreaterole noreplication password '${rolePassword}'`,
  );
  await admin.query(
    `grant ${role} to ${login} with admin false, inherit true, set true`,
  );
}
const connection = (login: string) => {
  const u = new URL(target);
  u.username = login;
  u.password = rolePassword;
  return u.toString();
};
const userId = randomUUID(),
  workspaceId = randomUUID(),
  sessionId = randomUUID();
const email = 'finance-browser@example.test',
  password = `Synthetic-${randomBytes(18).toString('base64url')}!`;
await admin.query(
  "insert into emdo.auth_users(id,name,email,email_verified) values($1,'Synthetic Finance Browser',$2,true)",
  [userId, email],
);
await admin.query(
  "insert into emdo.auth_accounts(id,user_id,account_id,provider_id,password) values($1,$2::uuid,$2::text,'credential',$3)",
  [randomUUID(), userId, await hashPassword(password)],
);
await admin.query(
  "insert into emdo.households(id,name,slug,created_by_user_id) values($1,'Synthetic Browser Workspace',$2,$3)",
  [workspaceId, workspaceId, userId],
);
await admin.query(
  "insert into emdo.household_memberships(household_id,user_id,role,status) values($1,$2,'owner','active')",
  [workspaceId, userId],
);
await admin.query(
  "insert into emdo.spaces(id,household_id,original_owner_user_id,name,visibility,revision) values($1,$2,$3,'Private','private',1)",
  [randomUUID(), workspaceId, userId],
);
// Seed-only session supports repository authorization. Browser must obtain its own real cookie through sign-in.
await admin.query(
  "insert into emdo.auth_sessions(id,user_id,token,expires_at,active_household_id) values($1,$2,$3,now()+interval '1 day',$4)",
  [sessionId, userId, randomBytes(32).toString('hex'), workspaceId],
);
const pool = new pg.Pool({ connectionString: connection('emdo_api_login') });
const scoped = {
  async connect() {
    const c = await pool.connect();
    await c.query('set role emdo_app');
    return c;
  },
};
const cipher = new FinanceBookEvidenceCrypto(
  new InMemoryVaultKeyProvider(randomBytes(32), 'finance-documents.v1'),
);
const financeV2 = new PostgresFinanceV2Repository(scoped, {
  evidenceCipher: {
    encrypt: (v, s) => cipher.encrypt(v, s),
    decrypt: (v, s) =>
      cipher.decrypt(EncryptedFinanceBookEvidenceSchema.parse(v), s),
  },
});
const financeStandardization = new PostgresFinanceStandardizationRepository(
  scoped,
);
const financeAutomations = new PostgresFinanceAutomationRepository(scoped);
const financeSchedules = new PostgresFinanceScheduleRepository(
  scoped,
  process.versions.tz!,
);
const financeGeneratedReports = new PostgresFinanceGeneratedReportRepository(
  scoped,
);
const context = { userId, workspaceId, sessionId, requestId: randomUUID() };
const book = await financeV2.createBook(context, randomUUID(), {
  name: 'Synthetic browser acceptance',
  entityName: 'Synthetic Canadian Company',
  entityKind: 'corporation',
  country: 'CA',
  functionalCurrency: 'CAD',
});
const bookId = String(book.id);
const cash = await financeV2.createAccount(context, bookId, randomUUID(), {
  code: '1000',
  name: 'Synthetic Cash',
  kind: 'asset',
});
const equity = await financeV2.createAccount(context, bookId, randomUUID(), {
  code: '3000',
  name: 'Synthetic Equity',
  kind: 'equity',
});
await financeV2.createAccount(context, bookId, randomUUID(), {
  code: '4000',
  name: 'Synthetic Revenue',
  kind: 'income',
});
await financeV2.createFinancialAccount(context, bookId, randomUUID(), {
  name: 'Synthetic Bank',
  kind: 'bank',
  currency: 'CAD',
  ledgerAccountId: String(cash.id),
});
await financeV2.createPeriod(context, bookId, randomUUID(), {
  startsOn: '2026-01-01',
  endsOn: '2026-12-31',
});
// A deliberately labelled synthetic opening makes scheduled reports independently checkable.
await financeV2.postJournal(context, bookId, randomUUID(), {
  effectiveOn: '2026-09-15',
  sourceReference: 'synthetic-browser-opening',
  description: 'Synthetic 12.34 CAD opening',
  lines: [
    {
      accountId: String(cash.id),
      side: 'debit',
      amount: '12.34',
      currency: 'CAD',
      nativeAmount: '12.34',
      fxRate: '1',
      fxSource: 'synthetic',
      description: '',
    },
    {
      accountId: String(equity.id),
      side: 'credit',
      amount: '12.34',
      currency: 'CAD',
      nativeAmount: '12.34',
      fxRate: '1',
      fxSource: 'synthetic',
      description: '',
    },
  ],
});
await admin.query(
  "insert into emdo.workspace_entitlements(workspace_id,capability,enabled) values($1,'finance.automations.run',true)",
  [workspaceId],
);
await admin.query(
  "update emdo.finance_automation_capabilities set ready=true where capability='finance.reports.generate'",
);
// Grants and schedules are deliberately created through the browser during acceptance.
for (const [login, role] of [
  ['emdo_worker_login', null],
  ['emdo_worker_executor_login', 'emdo_worker_executor'],
  ['emdo_worker_dispatcher_login', 'emdo_worker_dispatch_executor'],
  ['emdo_finance_scheduler_login', 'emdo_finance_scheduler'],
] as const) {
  await admin.query(
    `create role ${login} login nosuperuser nocreatedb nocreaterole noinherit nobypassrls noreplication password '${rolePassword}'`,
  );
  if (role)
    await admin.query(`grant ${role} to ${login} with inherit false, set true`);
}
const workerRequire = createRequire(resolve('apps/worker/package.json'));
const { PgBoss } = await import(workerRequire.resolve('pg-boss'));
const boss = new PgBoss({
  connectionString: target.toString(),
  schema: 'pgboss',
});
await boss.start();
await boss.stop();
await admin.query(
  'grant usage on schema pgboss to emdo_worker_login; grant all on all tables in schema pgboss to emdo_worker_login; grant all on all sequences in schema pgboss to emdo_worker_login; grant execute on all functions in schema pgboss to emdo_worker_login',
);
const healthPort = await new Promise<number>((done, reject) => {
  const listener = createNetServer();
  listener.once('error', reject);
  listener.listen(0, '127.0.0.1', () => {
    const address = listener.address();
    if (!address || typeof address === 'string')
      throw new Error('worker-health-address');
    listener.close(() => done(address.port));
  });
});
const worker = spawn(process.execPath, [resolve('apps/worker/dist/index.js')], {
  cwd: process.cwd(),
  env: {
    PATH: process.env.PATH,
    EMDO_ENVIRONMENT: 'staging',
    EMDO_SYNTHETIC_DATA_ONLY: 'true',
    EMDO_EXTERNAL_PROVIDERS_ENABLED: 'false',
    EMDO_APPLICATION_ORIGIN: 'https://localhost:4443',
    EMDO_WORKER_DATABASE_URL: connection('emdo_worker_login'),
    EMDO_WORKER_EXECUTOR_DATABASE_URL: connection('emdo_worker_executor_login'),
    EMDO_WORKER_DISPATCHER_DATABASE_URL: connection(
      'emdo_worker_dispatcher_login',
    ),
    EMDO_FINANCE_SCHEDULER_DATABASE_URL: connection(
      'emdo_finance_scheduler_login',
    ),
    EMDO_WORKER_DISPATCHER_ID: 'synthetic-browser-worker',
    EMDO_FINANCE_V2_ENABLED: 'true',
    EMDO_FINANCE_SCHEDULES_ENABLED: 'true',
    EMDO_FINANCE_STANDARDIZATION_ENABLED: 'false',
    HEALTH_HOST: '127.0.0.1',
    HEALTH_PORT: String(healthPort),
  },
  stdio: ['ignore', 'ignore', 'ignore'],
});
process.on('exit', () => worker.kill('SIGTERM'));
let workerReady = false;
for (let attempt = 0; attempt < 120; attempt++) {
  if (worker.exitCode !== null)
    throw new Error('synthetic-emitted-worker-exited');
  try {
    workerReady = (await fetch(`http://127.0.0.1:${healthPort}/readyz`)).ok;
  } catch {
    /* Startup race. */
  }
  if (workerReady) break;
  await new Promise((done) => setTimeout(done, 250));
}
if (!workerReady) throw new Error('synthetic-emitted-worker-not-ready');
const origin = 'https://localhost:4443';
const auth = await createProductionAuthenticationServiceBinding({
  EMDO_API_AUTH_SECRET: randomBytes(32).toString('base64url'),
  EMDO_SESSION_SECRET: randomBytes(32).toString('base64url'),
  EMDO_API_DATABASE_URL: connection('emdo_api_login'),
  EMDO_AUTH_DATABASE_URL: connection('emdo_auth_login'),
  EMDO_PUBLIC_ORIGIN: origin,
});
if (!auth.binding || !(await auth.binding.check()))
  throw new Error('production-auth-binding-unready');
const app = await createApp({
  services: {
    ...createFailClosedApiServices({ auth: auth.binding.service }),
    financeV2,
    financeStandardization,
    financeAutomations,
    financeSchedules,
    financeGeneratedReports,
  },
  publicOrigin: origin,
  allowLoopbackApiIngress: true,
});
await app.listen({ host: '127.0.0.1', port: 0 });
const address = app.server.address();
if (!address || typeof address === 'string')
  throw new Error('api-address-unavailable');
const webRoot = resolve('apps/web/dist');
const server = createServer(
  {
    key: await readFile(`${directory}/key.pem`),
    cert: await readFile(`${directory}/cert.pem`),
  },
  async (req, res) => {
    if (req.url?.startsWith('/api/') || req.url === '/healthz') {
      const proxy = httpRequest(
        {
          host: '127.0.0.1',
          port: address.port,
          path: req.url,
          method: req.method,
          headers: req.headers,
        },
        (upstream) => {
          res.writeHead(upstream.statusCode ?? 502, upstream.headers);
          upstream.pipe(res);
        },
      );
      proxy.on('error', () => {
        res.writeHead(502);
        res.end();
      });
      req.pipe(proxy);
      return;
    }
    try {
      const pathname = decodeURIComponent(
        new URL(req.url ?? '/', origin).pathname,
      );
      let path = resolve(webRoot, `.${pathname}`);
      if (!path.startsWith(webRoot + '/'))
        path = resolve(webRoot, 'index.html');
      if (!(await stat(path).catch(() => undefined))?.isFile())
        path = resolve(webRoot, 'index.html');
      const types: Record<string, string> = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.svg': 'image/svg+xml',
        '.json': 'application/json',
      };
      res.setHeader(
        'Content-Type',
        types[extname(path)] ?? 'application/octet-stream',
      );
      res.setHeader('Cache-Control', 'no-store');
      res.end(await readFile(path));
    } catch {
      res.writeHead(500);
      res.end('Local fixture unavailable');
    }
  },
);
await new Promise<void>((resolve) => server.listen(4443, '127.0.0.1', resolve));
await writeFile(
  `${directory}/login.json`,
  JSON.stringify(
    {
      url: origin + '/finance',
      email,
      password,
      bookId,
      scope: 'synthetic-local-only',
      provider: 'disabled',
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
console.log(
  JSON.stringify({
    event: 'finance-local-browser-ready',
    url: origin + '/finance',
    loginFile: `${directory}/login.json`,
    migrations: 77,
    serverPid: process.pid,
    workerPid: worker.pid,
    workerHealthPort: healthPort,
    automation: 'real-emitted-worker-and-pgboss-provider-free',
    auth: 'production-better-auth-and-csrf',
    provider: 'disabled',
  }),
);
await admin.end();
const close = async () => {
  worker.kill('SIGTERM');
  await new Promise<void>((done) => {
    if (worker.exitCode !== null) {
      done();
      return;
    }
    worker.once('exit', () => done());
    setTimeout(() => {
      worker.kill('SIGKILL');
      done();
    }, 5000).unref();
  });
  server.close();
  await app.close();
  await pool.end();
  await auth.close?.();
  process.exit(0);
};
process.on('SIGTERM', () => void close());
process.on('SIGINT', () => void close());
