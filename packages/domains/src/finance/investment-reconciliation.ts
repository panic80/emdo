/** Stable JSON equality for immutable PostgreSQL jsonb snapshots. */
export function canonicalInvestmentSnapshot(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(canonicalInvestmentSnapshot).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([key, item]) =>
          `${JSON.stringify(key)}:${canonicalInvestmentSnapshot(item)}`,
      )
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export function investmentReconciliationEffectiveStatus(
  status: 'open' | 'resolved',
  sourcesCurrent: boolean,
) {
  return sourcesCurrent ? status : ('reopen-required' as const);
}
