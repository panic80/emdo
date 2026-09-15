import { z } from 'zod';
import { normalizedAmountToLegacyCadMinor } from '@emdo/domains/finance';
import type { DatabaseClient } from './scoped-repository.js';

export type LegacyFinanceSourceScope = {
  workspaceId: string;
  sourceSpaceId: string;
  sourceOwnerUserId: string;
};
export type LegacyFinanceRoute =
  | { kind: 'legacy' }
  | {
      kind: 'normalized';
      migrationId: string;
      bookId: string;
      activatedAt: string;
    };
export type LegacyFinanceCompatibilityTransaction = {
  id: string;
  legacyEntityId: string | null;
  economicTransactionId: string;
  journalId: string;
  financialAccountId: string;
  legacyAccountId: string;
  categoryId: string | null;
  effectiveOn: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  nativeAmount: string;
  currency: 'CAD';
  amountCadMinor: number;
  originalFingerprint: string | null;
  originalSourceHash: string | null;
  originalSourceRow: number | null;
  externalId: string | null;
};

// Current explicit assignment heads are the sole account authority. Revoked heads
// never fall back to the archival migration rows.
const routedAccountsSql = `select h.workspace_id,h.book_id,r.migration_id,h.account_id as target_financial_account_id,
 coalesce(h.legacy_entity_id,'normalized-account:'||h.account_id::text) as entity_id,
 coalesce(x.legacy_row_id,h.account_id) as legacy_row_id,h.compatibility_account_kind as legacy_kind,
 x.payload->>'openingBalanceCadMinor' as legacy_opening,
 case when x.payload->>'openingBalanceCadMinor'='0' then null else
   emdo.finance_account_opening_proof(h.workspace_id,h.book_id,h.account_id,h.source_space_id,h.source_owner_user_id)->>'amount_cad_minor' end as proof_opening,
 case when x.payload->>'openingBalanceCadMinor'='0' then null else
   emdo.finance_account_opening_proof(h.workspace_id,h.book_id,h.account_id,h.source_space_id,h.source_owner_user_id)->>'id' end as proof_id
 from emdo.finance_account_source_assignments h
 join emdo.finance_legacy_activations r on r.workspace_id=h.workspace_id and r.book_id=h.book_id and r.source_space_id=h.source_space_id and r.source_owner_user_id=h.source_owner_user_id
 left join emdo.finance_legacy_migration_records x on x.workspace_id=h.workspace_id and x.book_id=h.book_id and x.migration_id=h.migration_id and x.entity_id=h.legacy_entity_id and x.entity_type='finance.account' and not x.tombstoned
 where h.workspace_id=$1 and r.migration_id=$2 and h.status='active'`;

function verifiedOpeningMinor(
  legacy: unknown,
  proof: unknown,
  proofId: unknown,
): number | null {
  if (legacy === '0') return 0;
  if (typeof proof !== 'string' || !/^-?\d+$/.test(proof)) return null;
  if (!z.string().uuid().safeParse(proofId).success) return null;
  const minor = BigInt(proof);
  if (
    legacy !== null &&
    legacy !== undefined &&
    (typeof legacy !== 'string' ||
      !/^-?\d+$/.test(legacy) ||
      BigInt(legacy) !== minor)
  )
    return null;
  if (
    minor > BigInt(Number.MAX_SAFE_INTEGER) ||
    minor < BigInt(Number.MIN_SAFE_INTEGER)
  )
    return null;
  return Number(minor);
}

/** Caller supplies an authenticated transaction. Revoked marker access throws. */
export async function resolveLegacyFinanceRoute(
  client: DatabaseClient,
  scope: LegacyFinanceSourceScope,
): Promise<LegacyFinanceRoute> {
  const result = await client.query(
    'select emdo.resolve_legacy_finance_route($1,$2,$3) as route',
    [scope.workspaceId, scope.sourceSpaceId, scope.sourceOwnerUserId],
  );
  return z
    .discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('legacy') }),
      z.strictObject({
        kind: z.literal('normalized'),
        migrationId: z.string().uuid(),
        bookId: z.string().uuid(),
        activatedAt: z.string().datetime({ offset: true }),
      }),
    ])
    .parse(result.rows[0]?.route);
}

export async function readLegacyFinanceCompatibility(
  client: DatabaseClient,
  route: Extract<LegacyFinanceRoute, { kind: 'normalized' }>,
  scope: LegacyFinanceSourceScope,
  page: {
    limit?: number;
    order?: 'date' | 'entity-id';
    afterEntityId?: string;
    entityId?: string;
    recordEntityIds?: string[];
    after?: { effectiveOn: string; id: string };
  } = {},
): Promise<
  | {
      kind: 'ready';
      accounts: Array<{
        id: string;
        financialAccountId: string;
        name: string;
        createdAt: string;
        updatedAt: string;
        accountKind: string;
        normalizedAccountKind: string;
        active: boolean;
        currency: 'CAD';
        openingBalanceCadMinor: number;
        balanceCadMinor: number | null;
      }>;
      nextCursor: { effectiveOn: string; id: string } | null;
      nextEntityId: string | null;
      transactions: LegacyFinanceCompatibilityTransaction[];
      archives: Array<{
        entityType: string;
        entityId: string;
        payload: unknown;
        tombstoned: boolean;
        authoritative: false;
      }>;
    }
  | { kind: 'unsupported-currency'; currency: string }
  | { kind: 'unsupported-opening'; financialAccountId: string }
  | { kind: 'unsupported-category'; economicTransactionId: string }
  | { kind: 'unsupported-amount'; economicTransactionId: string }
> {
  const current = await resolveLegacyFinanceRoute(client, scope);
  if (
    current.kind !== 'normalized' ||
    current.migrationId !== route.migrationId ||
    current.bookId !== route.bookId
  )
    throw new Error('legacy-finance-route-changed');
  const limit = z
    .number()
    .int()
    .min(1)
    .max(500)
    .parse(page.limit ?? 100);
  if (page.after) {
    z.string().date().parse(page.after.effectiveOn);
    z.string().uuid().parse(page.after.id);
  }
  if (page.afterEntityId !== undefined)
    z.string().min(1).max(512).parse(page.afterEntityId);
  if (page.entityId !== undefined)
    z.string().min(1).max(512).parse(page.entityId);
  if (page.recordEntityIds)
    z.array(z.string().min(1).max(512)).max(500).parse(page.recordEntityIds);
  const entityOrder = page.order === 'entity-id';
  const result = await client.query(
    `
    with routed_accounts as (${routedAccountsSql})
    select mapped.legacy_opening,mapped.proof_opening,mapped.proof_id,e.id,e.journal_id,e.financial_account_id,e.effective_on::text,e.description,e.created_at,e.native_amount::text,a.currency,
      mapped.entity_id as legacy_account_id,m.entity_id as legacy_entity_id,m.fingerprint,m.source_hash,m.source_row,e.external_id,category.category_ids
    from routed_accounts mapped
    join emdo.finance_financial_accounts a on a.workspace_id=mapped.workspace_id and a.book_id=mapped.book_id and a.id=mapped.target_financial_account_id
    join emdo.finance_economic_transactions e on e.workspace_id=a.workspace_id and e.book_id=a.book_id and e.financial_account_id=a.id
    join emdo.finance_journals j on j.workspace_id=e.workspace_id and j.book_id=e.book_id and j.id=e.journal_id and j.status='posted'
    left join lateral (select x.* from emdo.finance_legacy_migration_records x join emdo.finance_normalized_import_rows n on n.workspace_id=x.workspace_id and n.book_id=x.book_id and n.id=x.target_row_id where x.workspace_id=e.workspace_id and x.book_id=e.book_id and x.migration_id=mapped.migration_id and n.economic_transaction_id=e.id order by x.entity_id limit 1) m on true
    left join lateral (select array_agg(distinct c->>'legacyCategoryId') as category_ids from emdo.finance_legacy_migration_runs r cross join jsonb_array_elements(r.mapping->'categories') c where r.workspace_id=mapped.workspace_id and r.id=mapped.migration_id and exists(select 1 from emdo.finance_journal_lines l where l.workspace_id=e.workspace_id and l.book_id=e.book_id and l.journal_id=e.journal_id and l.account_id=(c->>'targetLedgerAccountId')::uuid and l.account_id<>a.ledger_account_id)) category on true
    where mapped.workspace_id=$1 and mapped.migration_id=$2
    and ($6::boolean or $3::date is null or (e.effective_on,e.id)>($3::date,$4::uuid))
    and (not $6::boolean or $7::text is null or coalesce(m.entity_id,'normalized:'||e.id::text)>$7::text)
    and ($8::text is null or coalesce(m.entity_id,'normalized:'||e.id::text)=$8::text)
    and ($9::text[] is null or coalesce(m.entity_id,'normalized:'||e.id::text)=any($9::text[]))
    order by case when $6::boolean then coalesce(m.entity_id,'normalized:'||e.id::text) end,case when not $6::boolean then e.effective_on end,e.id limit $5`,
    [
      scope.workspaceId,
      route.migrationId,
      page.after?.effectiveOn ?? null,
      page.after?.id ?? null,
      limit + 1,
      entityOrder,
      page.afterEntityId ?? null,
      page.entityId ?? null,
      page.recordEntityIds ?? null,
    ],
  );
  const transactions: LegacyFinanceCompatibilityTransaction[] = [];
  const seen = new Set<string>();
  for (const row of result.rows.slice(0, limit)) {
    if (seen.has(String(row.id))) continue;
    seen.add(String(row.id));
    if (
      verifiedOpeningMinor(
        row.legacy_opening,
        row.proof_opening,
        row.proof_id,
      ) === null
    )
      return {
        kind: 'unsupported-opening',
        financialAccountId: String(row.financial_account_id),
      };
    if (row.currency !== 'CAD')
      return { kind: 'unsupported-currency', currency: String(row.currency) };
    let cents: number;
    try {
      cents = normalizedAmountToLegacyCadMinor(
        String(row.native_amount),
        String(row.currency),
      );
    } catch {
      return {
        kind: 'unsupported-amount',
        economicTransactionId: String(row.id),
      };
    }
    const categories = z.array(z.string()).parse(row.category_ids ?? []);
    if (categories.length > 1)
      return {
        kind: 'unsupported-category',
        economicTransactionId: String(row.id),
      };
    transactions.push({
      id:
        row.legacy_entity_id == null
          ? `normalized:${row.id}`
          : String(row.legacy_entity_id),
      legacyEntityId:
        row.legacy_entity_id == null ? null : String(row.legacy_entity_id),
      economicTransactionId: String(row.id),
      journalId: String(row.journal_id),
      financialAccountId: String(row.financial_account_id),
      legacyAccountId: String(row.legacy_account_id),
      categoryId: categories[0] ?? null,
      effectiveOn: String(row.effective_on),
      description: String(row.description),
      createdAt: new Date(String(row.created_at)).toISOString(),
      updatedAt: new Date(String(row.created_at)).toISOString(),
      nativeAmount: String(row.native_amount),
      currency: 'CAD',
      amountCadMinor: cents,
      originalFingerprint:
        row.fingerprint == null ? null : String(row.fingerprint),
      originalSourceHash:
        row.source_hash == null ? null : String(row.source_hash),
      originalSourceRow: row.source_row == null ? null : Number(row.source_row),
      externalId: row.external_id == null ? null : String(row.external_id),
    });
  }
  const archive = await client.query(
    `select entity_type,entity_id,payload,tombstoned from emdo.finance_legacy_migration_records where workspace_id=$1 and migration_id=$2 and entity_type not in ('finance.account','finance.transaction') and ($3::text[] is null or entity_id=any($3::text[])) order by entity_type,entity_id limit 10001`,
    [scope.workspaceId, route.migrationId, page.recordEntityIds ?? null],
  );
  if (archive.rows.length > 10000)
    throw new Error('legacy-archive-projection-limit');
  const accountRows = await client.query(
    `with routed_accounts as (${routedAccountsSql}) select x.entity_id,a.id,a.name,a.kind,a.active,a.currency,a.created_at,x.legacy_kind,x.legacy_opening,x.proof_opening,x.proof_id from routed_accounts x join emdo.finance_financial_accounts a on a.workspace_id=x.workspace_id and a.book_id=x.book_id and a.id=x.target_financial_account_id where ($3::text[] is null or x.entity_id=any($3::text[])) order by x.entity_id limit 10001`,
    [scope.workspaceId, route.migrationId, page.recordEntityIds ?? null],
  );
  if (accountRows.rows.length > 10000)
    throw new Error('legacy-account-projection-limit');
  const accounts: Array<{
    id: string;
    financialAccountId: string;
    name: string;
    createdAt: string;
    updatedAt: string;
    accountKind: string;
    normalizedAccountKind: string;
    active: boolean;
    currency: 'CAD';
    openingBalanceCadMinor: number;
    balanceCadMinor: number | null;
  }> = [];
  for (const a of accountRows.rows) {
    if (a.currency !== 'CAD')
      return { kind: 'unsupported-currency', currency: String(a.currency) };
    const opening = verifiedOpeningMinor(
      a.legacy_opening,
      a.proof_opening,
      a.proof_id,
    );
    if (opening === null)
      return { kind: 'unsupported-opening', financialAccountId: String(a.id) };
    accounts.push({
      id: String(a.entity_id),
      financialAccountId: String(a.id),
      name: String(a.name),
      createdAt: new Date(String(a.created_at)).toISOString(),
      updatedAt: new Date(String(a.created_at)).toISOString(),
      accountKind: z
        .enum(['cash', 'chequing', 'savings', 'credit', 'other'])
        .parse(a.legacy_kind),
      normalizedAccountKind: z
        .enum(['bank', 'brokerage', 'credit-card', 'cash'])
        .parse(a.kind),
      active: z.boolean().parse(a.active),
      currency: 'CAD',
      openingBalanceCadMinor: opening,
      balanceCadMinor: null,
    });
  }
  const last = transactions.at(-1);
  return {
    kind: 'ready',
    accounts,
    nextEntityId: result.rows.length > limit && last ? last.id : null,
    nextCursor:
      result.rows.length > limit && last
        ? { effectiveOn: last.effectiveOn, id: last.economicTransactionId }
        : null,
    transactions,
    archives: archive.rows.map((row) => ({
      entityType: String(row.entity_type),
      entityId: String(row.entity_id),
      payload: row.payload,
      tombstoned: Boolean(row.tombstoned),
      authoritative: false,
    })),
  };
}

/** Mixed legacy-compatible UUID cursor. The database limits candidates before projection. */
export async function readLegacyFinanceCompatibilityPage(
  client: DatabaseClient,
  route: Extract<LegacyFinanceRoute, { kind: 'normalized' }>,
  scope: LegacyFinanceSourceScope,
  page: {
    limit?: number;
    cursor?: string;
    entityTypes?: string[];
    month?: string;
  } = {},
) {
  const current = await resolveLegacyFinanceRoute(client, scope);
  if (
    current.kind !== 'normalized' ||
    current.migrationId !== route.migrationId ||
    current.bookId !== route.bookId
  )
    throw new Error('legacy-finance-route-changed');
  const limit = z
    .number()
    .int()
    .min(1)
    .max(500)
    .parse(page.limit ?? 100);
  const cursor =
    page.cursor === undefined ? null : z.string().uuid().parse(page.cursor);
  const types = z
    .array(
      z.enum([
        'finance.account',
        'finance.transaction',
        'finance.category',
        'finance.budget',
        'finance.bill',
        'finance.subscription',
        'finance.goal',
      ]),
    )
    .max(7)
    .parse(
      page.entityTypes ?? [
        'finance.account',
        'finance.transaction',
        'finance.category',
        'finance.budget',
        'finance.bill',
        'finance.subscription',
        'finance.goal',
      ],
    );
  const month =
    page.month === undefined
      ? null
      : z
          .string()
          .regex(/^\d{4}-(0[1-9]|1[0-2])$/u)
          .parse(page.month) + '-01';
  const result = await client.query(
    `
    with routed_accounts as (${routedAccountsSql}), candidates as (
      select x.legacy_row_id as row_id,x.entity_id,x.entity_type from emdo.finance_legacy_migration_records x
      where x.workspace_id=$1 and x.migration_id=$2 and not x.tombstoned and x.entity_type not in ('finance.transaction','finance.account') and $5::date is null
      union all
      select legacy_row_id,entity_id,'finance.account' from routed_accounts where $5::date is null
      union all
      select coalesce(m.legacy_row_id,e.id),coalesce(m.entity_id,'normalized:'||e.id::text),'finance.transaction'
      from routed_accounts a
      join emdo.finance_economic_transactions e on e.workspace_id=a.workspace_id and e.book_id=a.book_id and e.financial_account_id=a.target_financial_account_id
      join emdo.finance_journals j on j.workspace_id=e.workspace_id and j.book_id=e.book_id and j.id=e.journal_id and j.status='posted'
      left join lateral (select x.legacy_row_id,x.entity_id from emdo.finance_legacy_migration_records x join emdo.finance_normalized_import_rows n on n.workspace_id=x.workspace_id and n.book_id=x.book_id and n.id=x.target_row_id where x.workspace_id=e.workspace_id and x.book_id=e.book_id and x.migration_id=a.migration_id and n.economic_transaction_id=e.id order by x.entity_id limit 1) m on true
      where a.workspace_id=$1 and a.migration_id=$2
       and ($5::date is null or (e.effective_on >= $5::date and e.effective_on < $5::date+interval '1 month'))
    ) select row_id::text,entity_id,entity_type from candidates where entity_type=any($3::text[]) and ($4::uuid is null or row_id>$4::uuid) order by row_id limit $6`,
    [scope.workspaceId, route.migrationId, types, cursor, month, limit + 1],
  );
  const rows = z
    .array(
      z.object({
        row_id: z.string().uuid(),
        entity_id: z.string(),
        entity_type: z.string(),
      }),
    )
    .parse(result.rows);
  if (new Set(rows.map((row) => row.row_id)).size !== rows.length)
    throw new Error('legacy-finance-cursor-collision');
  const selected = rows.slice(0, limit);
  const projection = await readLegacyFinanceCompatibility(
    client,
    route,
    scope,
    { limit: 500, recordEntityIds: selected.map((row) => row.entity_id) },
  );
  if (projection.kind !== 'ready') return projection;
  return {
    kind: 'ready' as const,
    entries: selected.map((row) => ({
      rowId: row.row_id,
      entityId: row.entity_id,
      entityType: row.entity_type,
    })),
    projection,
    nextCursor: rows.length > limit ? selected.at(-1)!.row_id : null,
  };
}
