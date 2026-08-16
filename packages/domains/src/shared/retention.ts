export interface RetentionPolicy {
  readonly auditMetadataDays: number;
  readonly operationalTraceDays: number;
}

export const MVP_RETENTION_POLICY: RetentionPolicy = Object.freeze({
  auditMetadataDays: 365,
  operationalTraceDays: 90,
});

export interface RetainedRecord {
  readonly createdAt: string;
  readonly legalHold: boolean;
}

export const isEligibleForRetentionPurge = (
  record: RetainedRecord,
  retentionDays: number,
  now: Date,
): boolean => {
  if (
    record.legalHold ||
    !Number.isInteger(retentionDays) ||
    retentionDays < 0
  ) {
    return false;
  }
  const createdAt = Date.parse(record.createdAt);
  if (!Number.isFinite(createdAt)) {
    return false;
  }
  return now.getTime() - createdAt >= retentionDays * 86_400_000;
};
