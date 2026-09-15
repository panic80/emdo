import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { expect, it } from 'vitest';
import type { WorkspaceContext } from '@emdo/contracts';
import { FinanceBookEvidenceCrypto } from '../../integrations/src/finance-documents/book-evidence-crypto.js';
import { InMemoryVaultKeyProvider } from '../../integrations/src/vault/crypto.js';
import { PostgresFinanceV2Repository } from './finance-v2-repository.js';
import { PostgresFranceFecMappingRepository } from './finance-fec-mapping-repository.js';
import { PostgresFranceFecRepository } from './finance-fec-repository.js';
import { PostgresFinancePlanningRepository } from './finance-planning-repository.js';
import { PostgresFinanceTaxRepository } from './finance-tax-repository.js';

const image =
  'pgvector/pgvector@sha256:2ba9ca5f2e7daa0f0e7723cba1ee9167bab54efd3640516a44ac1a928dd67e7a';
const run = (
  command: string,
  args: string[],
  input?: Buffer,
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 30000);
    const chunks: Buffer[] = [];
    let bytes = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 64 * 1024 * 1024) child.kill();
      else chunks.push(chunk);
    });
    // Tool errors must not print key material, dump contents, or SQL source data.
    child.stderr.resume();
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', () => clearTimeout(timeout));
    child.on('close', (code) =>
      code === 0
        ? resolve(Buffer.concat(chunks))
        : reject(
            new Error(`finance-restore-command-failed:${command}:${code}`),
          ),
    );
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });

const startCluster = async (container: string, database: string) => {
  await run('docker', [
    'run',
    '--detach',
    '--rm',
    '--name',
    container,
    '--publish',
    '127.0.0.1::5432',
    '--env',
    'POSTGRES_HOST_AUTH_METHOD=trust',
    '--env',
    `POSTGRES_DB=${database}`,
    image,
  ]);
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await run('docker', [
        'exec',
        container,
        'pg_isready',
        '-h',
        '127.0.0.1',
        '-U',
        'postgres',
      ]);
      ready = true;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  expect(ready).toBe(true);
  const port = (await run('docker', ['port', container, '5432/tcp']))
    .toString()
    .trim()
    .split(':')
    .at(-1);
  expect(port).toMatch(/^\d+$/u);
  return port!;
};
const applyMigrations = async (
  pool: pg.Pool,
  migrations: readonly { sql: string }[],
) => {
  for (const migration of migrations) {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(migration.sql);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }
};
const roleState = async (pool: pg.Pool) => ({
  roles: (
    await pool.query(
      "select rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls from pg_roles where rolname like 'emdo_%' order by rolname",
    )
  ).rows,
  memberships: (
    await pool.query(
      "select parent.rolname as parent,member.rolname as member,m.admin_option,m.inherit_option,m.set_option from pg_auth_members m join pg_roles parent on parent.oid=m.roleid join pg_roles member on member.oid=m.member where parent.rolname like 'emdo_%' or member.rolname like 'emdo_%' order by parent.rolname,member.rolname",
    )
  ).rows,
});

/** Explicit local drill only; never accepts an existing database or application credentials. */
it.skipIf(process.env.EMDO_FINANCE_RESTORE_DRILL !== '1')(
  'restores encrypted accounting and evidence into a separately bootstrapped cluster with private access intact',
  async () => {
    const container = `emdo-finance-restore-${randomUUID()}`;
    const restoreContainer = `emdo-finance-restore-target-${randomUUID()}`;
    let restoredEvidenceKey: Buffer | undefined;
    const directory = await mkdtemp(join(tmpdir(), 'emdo-finance-restore-'));
    const pools: pg.Pool[] = [];
    const evidenceKey = randomBytes(32);
    try {
      const port = await startCluster(container, 'source');
      const source = new pg.Pool({
        connectionString: `postgresql://postgres@127.0.0.1:${port}/source`,
      });
      pools.push(source);
      const { entries } = JSON.parse(
        await readFile(
          new URL('../drizzle/meta/_journal.json', import.meta.url),
          'utf8',
        ),
      ) as { entries: { tag: string }[] };
      // Pin migration bytes once: concurrent future migrations cannot alter this drill.
      const migrations = await Promise.all(
        entries.map(async ({ tag }) => {
          const sql = await readFile(
            new URL(`../drizzle/${tag}.sql`, import.meta.url),
            'utf8',
          );
          return {
            tag,
            sql,
            sha256: createHash('sha256').update(sql).digest('hex'),
          };
        }),
      );
      await applyMigrations(source, migrations);
      const sourceRoles = await roleState(source);
      const context: WorkspaceContext = {
        workspaceId: randomUUID(),
        userId: randomUUID(),
        sessionId: randomUUID(),
        requestId: randomUUID(),
      };
      const other = {
        ...context,
        userId: randomUUID(),
        sessionId: randomUUID(),
        requestId: randomUUID(),
      };
      await source.query(
        "insert into emdo.auth_users(id,name,email,email_verified) values($1,'Restore owner',$2,true),($3,'Workspace owner',$4,true)",
        [
          context.userId,
          `${context.userId}@example.test`,
          other.userId,
          `${other.userId}@example.test`,
        ],
      );
      await source.query(
        "insert into emdo.households(id,name,created_by_user_id,slug) values($1::uuid,'Synthetic restore',$2,$1::text)",
        [context.workspaceId, other.userId],
      );
      await source.query(
        "insert into emdo.household_memberships(household_id,user_id,role) values($1,$2,'member'),($1,$3,'owner')",
        [context.workspaceId, context.userId, other.userId],
      );
      for (const actor of [context, other])
        await source.query(
          "insert into emdo.auth_sessions(id,user_id,token,expires_at,active_household_id) values($1::uuid,$2,$1::text,now()+interval '1 day',$3)",
          [actor.sessionId, actor.userId, actor.workspaceId],
        );
      const restricted = (pool: pg.Pool) => ({
        async connect() {
          const client = await pool.connect();
          await client.query('set role emdo_app');
          return client;
        },
      });
      const cipher = (key: Uint8Array = evidenceKey) =>
        new FinanceBookEvidenceCrypto(
          new InMemoryVaultKeyProvider(key, 'finance-documents.v1'),
        );
      const books = new PostgresFinanceV2Repository(restricted(source), {
        evidenceCipher: cipher(),
      });
      const tax = new PostgresFinanceTaxRepository(restricted(source));
      const bookId = String(
        (
          await books.createBook(context, 'restore-book', {
            name: 'Operating',
            entityName: 'Synthetic',
            entityKind: 'corporation',
            country: 'CA',
            functionalCurrency: 'CAD',
          })
        ).id,
      );
      const bank = String(
        (
          await books.createAccount(context, bookId, 'bank', {
            code: '1000',
            name: 'Cash',
            kind: 'asset',
          })
        ).id,
      );
      const equity = String(
        (
          await books.createAccount(context, bookId, 'equity', {
            code: '3000',
            name: 'Capital',
            kind: 'equity',
          })
        ).id,
      );
      const period = await books.createPeriod(context, bookId, 'period', {
        startsOn: '2026-01-01',
        endsOn: '2026-12-31',
      });
      const journal = await books.postJournal(context, bookId, 'posting', {
        effectiveOn: '2026-09-13',
        description: 'Synthetic opening',
        sourceReference: 'synthetic:restore',
        lines: [
          {
            accountId: bank,
            side: 'debit',
            amount: '123.45',
            currency: 'CAD',
            nativeAmount: '123.45',
            fxRate: '1',
            fxSource: 'identity',
          },
          {
            accountId: equity,
            side: 'credit',
            amount: '123.45',
            currency: 'CAD',
            nativeAmount: '123.45',
            fxRate: '1',
            fxSource: 'identity',
          },
        ],
      });
      const planning = new PostgresFinancePlanningRepository(
        restricted(source),
      );
      const budget = await planning.saveBudget(context, bookId, randomUUID(), {
        name: 'Recovery plan',
        lines: [
          {
            accountId: bank,
            periodId: String(period.id),
            currency: 'CAD',
            amount: '200.00',
          },
        ],
      });
      const forecast = await planning.saveForecast(
        context,
        bookId,
        randomUUID(),
        {
          budgetId: budget.budgetId,
          budgetRevision: budget.revision,
          asOf: '2026-09-14',
          openingBalance: {
            status: 'unavailable',
            label: 'opening-balance-unavailable',
          },
          assumptions: [],
        },
      );
      const original = {
        filename: 'restore.csv',
        format: 'csv',
        sourceText:
          'Date,Description,Amount\n2026-09-13,SYNTHETIC-RESTORE-EVIDENCE,123.45',
      };
      const evidence = await books.uploadBookEvidence(
        context,
        bookId,
        'original',
        original,
      );
      const fecBookId = String(
        (
          await books.createBook(context, 'fec-restore-book', {
            name: 'French operating',
            entityName: 'Synthetic France',
            entityKind: 'corporation',
            country: 'FR',
            functionalCurrency: 'EUR',
          })
        ).id,
      );
      const fecBank = String(
        (
          await books.createAccount(context, fecBookId, 'fec-bank', {
            code: '512',
            name: 'Bank',
            kind: 'asset',
          })
        ).id,
      );
      const fecEquity = String(
        (
          await books.createAccount(context, fecBookId, 'fec-equity', {
            code: '101',
            name: 'Capital',
            kind: 'equity',
          })
        ).id,
      );
      await books.createPeriod(context, fecBookId, 'fec-period', {
        startsOn: '2026-01-01',
        endsOn: '2026-12-31',
      });
      const fecJournal = await books.postJournal(
        context,
        fecBookId,
        'fec-opening',
        {
          effectiveOn: '2026-01-01',
          description: 'Opening capital',
          sourceReference: 'synthetic:restore:fec-opening',
          lines: [
            {
              accountId: fecBank,
              side: 'debit',
              amount: '100.50',
              currency: 'EUR',
              nativeAmount: '100.50',
              fxRate: '1',
              fxSource: 'identity',
            },
            {
              accountId: fecEquity,
              side: 'credit',
              amount: '100.50',
              currency: 'EUR',
              nativeAmount: '100.50',
              fxRate: '1',
              fxSource: 'identity',
            },
          ],
        },
      );
      const fecOriginal = {
        filename: 'fec-legal.csv',
        format: 'csv',
        sourceText: 'SYNTHETIC-FEC-RESTORE-LEGAL-EVIDENCE',
      };
      const fecEvidence = await books.uploadBookEvidence(
        context,
        fecBookId,
        'fec-legal',
        fecOriginal,
      );
      const fecSource = {
        sourceReference: `evidence:${fecEvidence.id}`,
        sourceDigest: createHash('sha256')
          .update(fecOriginal.sourceText)
          .digest('hex'),
      };
      const fecMappings = new PostgresFranceFecMappingRepository(
        restricted(source),
      );
      const fecExports = new PostgresFranceFecRepository(restricted(source));
      await fecMappings.create(context, fecBookId, {
        expectedRevision: 0,
        siren: '123456789',
        sirenSource: fecSource,
        openingBalances: { status: 'included', source: fecSource },
        journals: [
          {
            journalId: String(fecJournal.id),
            entrySequence: 1,
            entryNumber: 'AN-1',
            entryKind: 'opening',
            journalCode: 'AN',
            journalLabel: 'Opening',
            pieceReference: 'OPEN-2026',
            pieceDate: '2026-01-01',
            entryLabel: 'Opening capital',
            validationDate: '2026-01-01',
          },
        ],
        accounts: [
          {
            accountId: fecBank,
            accountNumber: '512000',
            accountLabel: 'Bank',
            auxiliary: null,
          },
          {
            accountId: fecEquity,
            accountNumber: '101000',
            accountLabel: 'Capital',
            auxiliary: null,
          },
        ],
      });
      const fecMappingBefore = await fecMappings.getLatest(context, fecBookId);
      const fecRequest = {
        startsOn: '2026-01-01',
        endsOn: '2026-12-31',
        mappingRevision: 1,
        idempotencyKey: 'fec-restore-export',
      };
      const fecExportBefore = await fecExports.export(
        context,
        fecBookId,
        fecRequest,
      );
      expect(fecExportBefore.status).toBe('ready');
      if (fecExportBefore.status !== 'ready')
        throw new Error('synthetic-fec-restore-export-blocked');
      const fecHash = createHash('sha256')
        .update(fecExportBefore.file.content)
        .digest('hex');
      const taxCase = await tax.createCase(context, 'case', {
        mode: 'intake-only',
        title: 'Private inputs',
        taxSubjectName: 'Synthetic taxpayer',
        scope: {
          country: 'CA',
          subdivision: 'ON',
          taxpayerType: 'individual',
          year: 2025,
          regime: 'resident',
          formVersion: '2025',
        },
        domesticResident: true,
        hasCrossBorderActivity: false,
        standaloneCorporation: null,
        relatedParties: [],
      });
      await tax.recordDeclaration(context, taxCase.caseId, 'declaration', {
        expectedCaseRevision: 1,
        expectedSourceRevision: null,
        factKey: 'employment-income',
        category: 'income',
        value: { type: 'decimal', value: '123.4500' },
      });
      const before = await tax.getCase(context, taxCase.caseId);
      const accounting = await books.overview(context, bookId);
      const identity = join(directory, 'backup.age-key');
      await run('age-keygen', ['-o', identity]);
      const recipient = (await run('age-keygen', ['-y', identity]))
        .toString()
        .trim();
      const dump = await run('docker', [
        'exec',
        container,
        'pg_dump',
        '-U',
        'postgres',
        '--format=custom',
        '--compress=9',
        'source',
      ]);
      const encrypted = await run(
        'age',
        ['--encrypt', '--recipient', recipient],
        dump,
      );
      const keyBackup = join(directory, 'evidence-key.age');
      await writeFile(
        keyBackup,
        await run('age', ['--encrypt', '--recipient', recipient], evidenceKey),
        { mode: 0o600 },
      );
      const manifest = Buffer.from(
        JSON.stringify({
          image,
          migrations: migrations.map(({ tag, sha256 }) => ({ tag, sha256 })),
        }),
      );
      const manifestBackup = join(directory, 'manifest.json.age');
      await writeFile(
        manifestBackup,
        await run('age', ['--encrypt', '--recipient', recipient], manifest),
        { mode: 0o600 },
      );
      const backup = join(directory, 'source.dump.age');
      await writeFile(backup, encrypted, { mode: 0o600 });
      expect(encrypted.includes(Buffer.from(original.sourceText))).toBe(false);
      expect(encrypted.includes(Buffer.from(fecOriginal.sourceText))).toBe(
        false,
      );
      expect(
        encrypted.includes(Buffer.from(fecExportBefore.file.content)),
      ).toBe(false);
      const corrupted = Buffer.from(encrypted);
      corrupted[corrupted.length - 1] = corrupted[corrupted.length - 1]! ^ 1;
      await expect(
        run('age', ['--decrypt', '--identity', identity], corrupted),
      ).rejects.toThrow('finance-restore-command-failed');
      const restoredBytes = await run('age', [
        '--decrypt',
        '--identity',
        identity,
        backup,
      ]);
      expect(restoredBytes.equals(dump)).toBe(true);
      // Bootstrap cluster-scoped roles from the exact captured migration bytes.
      // This target has no access to the source cluster's roles, storage or keys.
      const restorePort = await startCluster(restoreContainer, 'bootstrap');
      expect(restorePort).not.toBe(port);
      const bootstrap = new pg.Pool({
        connectionString: `postgresql://postgres@127.0.0.1:${restorePort}/bootstrap`,
      });
      pools.push(bootstrap);
      expect(
        (
          await run('age', [
            '--decrypt',
            '--identity',
            identity,
            manifestBackup,
          ])
        ).equals(manifest),
      ).toBe(true);
      await applyMigrations(bootstrap, migrations);
      expect(await roleState(bootstrap)).toEqual(sourceRoles);
      await bootstrap.query('create database restored');
      evidenceKey.fill(0);
      restoredEvidenceKey = await run('age', [
        '--decrypt',
        '--identity',
        identity,
        keyBackup,
      ]);
      expect(restoredEvidenceKey).toHaveLength(32);
      await run(
        'docker',
        [
          'exec',
          '-i',
          restoreContainer,
          'pg_restore',
          '-U',
          'postgres',
          '--exit-on-error',
          '--clean',
          '--if-exists',
          '--dbname=restored',
        ],
        restoredBytes,
      );
      dump.fill(0);
      restoredBytes.fill(0);
      const restored = new pg.Pool({
        connectionString: `postgresql://postgres@127.0.0.1:${restorePort}/restored`,
      });
      pools.push(restored);
      const restoredBooks = new PostgresFinanceV2Repository(
        restricted(restored),
        { evidenceCipher: cipher(restoredEvidenceKey) },
      );
      const restoredFecMappings = new PostgresFranceFecMappingRepository(
        restricted(restored),
      );
      const restoredFecExports = new PostgresFranceFecRepository(
        restricted(restored),
      );
      expect(await restoredFecMappings.getLatest(context, fecBookId)).toEqual(
        fecMappingBefore,
      );
      const restoredFecExport = await restoredFecExports.getSavedExport(
        context,
        fecBookId,
        fecRequest.idempotencyKey,
      );
      expect(restoredFecExport).toEqual(fecExportBefore);
      if (restoredFecExport?.status !== 'ready')
        throw new Error('restored-fec-receipt-missing');
      expect(
        createHash('sha256')
          .update(restoredFecExport.file.content)
          .digest('hex'),
      ).toBe(fecHash);
      expect(
        await restoredBooks.downloadBookEvidence(
          context,
          fecBookId,
          String(fecEvidence.id),
        ),
      ).toMatchObject(fecOriginal);
      await expect(
        restoredFecMappings.getLatest(other, fecBookId),
      ).rejects.toMatchObject({ code: 'authorization-revoked' });
      await expect(
        restoredFecExports.getSavedExport(
          other,
          fecBookId,
          fecRequest.idempotencyKey,
        ),
      ).rejects.toMatchObject({ code: 'authorization-revoked' });
      await expect(
        restoredBooks.downloadBookEvidence(
          other,
          fecBookId,
          String(fecEvidence.id),
        ),
      ).rejects.toThrow('forbidden');
      const restoredTax = new PostgresFinanceTaxRepository(
        restricted(restored),
      );
      const restoredPlanning = new PostgresFinancePlanningRepository(
        restricted(restored),
      );
      expect(
        await restoredPlanning.getBudget(
          context,
          bookId,
          budget.budgetId,
          budget.revision,
        ),
      ).toEqual(budget);
      expect(
        await restoredPlanning.getForecast(
          context,
          bookId,
          forecast.forecastId,
          forecast.revision,
        ),
      ).toEqual(forecast);
      await expect(
        restoredPlanning.getBudget(
          other,
          bookId,
          budget.budgetId,
          budget.revision,
        ),
      ).rejects.toThrow();
      expect(await restoredBooks.overview(context, bookId)).toEqual(accounting);
      expect(
        await restoredBooks.downloadBookEvidence(
          context,
          bookId,
          String(evidence.id),
        ),
      ).toMatchObject(original);
      expect(await restoredTax.getCase(context, taxCase.caseId)).toEqual(
        before,
      );
      await expect(
        restoredBooks.downloadBookEvidence(other, bookId, String(evidence.id)),
      ).rejects.toThrow('forbidden');
      await expect(restoredTax.getCase(other, taxCase.caseId)).rejects.toThrow(
        'forbidden',
      );
      const client = await restored.connect();
      try {
        await client.query('reset role');
        // History triggers survive the dump even for administrative UPDATE attempts.
        await expect(
          client.query(
            "update emdo.finance_fec_book_mapping_revisions set siren='987654321' where workspace_id=$1 and book_id=$2 and revision=1",
            [context.workspaceId, fecBookId],
          ),
        ).rejects.toThrow();
        expect(await restoredFecMappings.getLatest(context, fecBookId)).toEqual(
          fecMappingBefore,
        );
        const policies = await client.query(
          "select relname,relrowsecurity,relforcerowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='emdo' and relname in ('finance_books','finance_book_evidence','finance_tax_cases','finance_tax_case_snapshots') order by relname",
        );
        expect(policies.rows).toHaveLength(4);
        expect(
          policies.rows.every(
            (row) => row.relrowsecurity && row.relforcerowsecurity,
          ),
        ).toBe(true);
        await client.query('set role emdo_app');
        await client.query('begin');
        await client.query(
          "select set_config('emdo.user_id',$1,true),set_config('emdo.session_id',$2,true),set_config('emdo.request_id',$3,true)",
          [context.userId, context.sessionId, randomUUID()],
        );
        await expect(
          client.query(
            "update emdo.finance_journals set description='rewritten' where id=$1",
            [journal.id],
          ),
        ).rejects.toThrow();
        await client.query('rollback');
        await client.query('begin');
        await client.query(
          "select set_config('emdo.user_id',$1,true),set_config('emdo.session_id',$2,true),set_config('emdo.request_id',$3,true)",
          [context.userId, context.sessionId, randomUUID()],
        );
        await expect(
          client.query(
            'insert into emdo.finance_budget_lines(workspace_id,book_id,budget_id,revision,period_id,account_id,currency,amount) values($1,$2,$3,$4,$5,$6,$7,$8)',
            [
              context.workspaceId,
              bookId,
              budget.budgetId,
              budget.revision,
              String(period.id),
              equity,
              'CAD',
              '1',
            ],
          ),
        ).rejects.toThrow('finance-planning-history-append-forbidden');
        await client.query('rollback');
      } finally {
        client.release();
      }
      process.stdout.write(
        JSON.stringify({
          event: 'finance-separate-cluster-restore-verified',
          migrationCount: migrations.length,
          finalMigration: migrations.at(-1)?.tag,
          bootstrapManifestSha256: createHash('sha256')
            .update(manifest)
            .digest('hex'),
          roleBootstrapMatched: true,
          encryptedEvidenceKeyRestored: true,
          fecMappingAndReceiptRestored: true,
          fecContentSha256: fecHash,
        }) + '\n',
      );
    } finally {
      await Promise.all(pools.map((pool) => pool.end()));
      evidenceKey.fill(0);
      restoredEvidenceKey?.fill(0);
      await run('docker', ['rm', '-f', '-v', container]).catch(() => undefined);
      await run('docker', ['rm', '-f', '-v', restoreContainer]).catch(
        () => undefined,
      );
      await rm(directory, { recursive: true, force: true });
    }
  },
  120000,
);
