const FinanceRecordsWriteGuardedOperations = new Set([
  'finance-adjustment',
  'finance-reversal',
  'finance-document-review-commit',
  'finance-document-match-accept',
  'finance-document-delete',
]);

const FinanceDocumentGuardedOperations = new Set([
  'finance-document-review-commit',
  'finance-document-match-accept',
  'finance-document-delete',
]);

export const isFinanceDocumentGuardedOperation = (operation: string): boolean =>
  FinanceDocumentGuardedOperations.has(operation);

export const isApprovedFinanceGuardedCapabilityOperation = (
  capabilityId: string,
  operation: string,
): boolean =>
  (capabilityId === 'finance.records.write' &&
    FinanceRecordsWriteGuardedOperations.has(operation)) ||
  (capabilityId === 'finance.statement.import' &&
    operation === 'finance-statement-import-commit');
