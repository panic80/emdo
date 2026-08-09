import type { EncryptedVaultPayload, VaultScope } from './crypto.js';

export interface VaultRecord {
  readonly scope: VaultScope;
  readonly ownerUserId: string;
  readonly payload: EncryptedVaultPayload;
  readonly createdAt: Date;
}

const scopeKey = (scope: VaultScope) =>
  JSON.stringify([scope.householdId, scope.spaceId, scope.recordId]);

const cloneRecord = (record: VaultRecord): VaultRecord =>
  Object.freeze({
    scope: Object.freeze({ ...record.scope }),
    ownerUserId: record.ownerUserId,
    payload: Object.freeze({ ...record.payload }),
    createdAt: new Date(record.createdAt),
  });

export class InMemoryVaultRepository {
  private readonly records = new Map<string, VaultRecord>();

  async put(record: VaultRecord) {
    const current = this.records.get(scopeKey(record.scope));
    if (current !== undefined && current.ownerUserId !== record.ownerUserId) {
      throw new Error('Vault record ownership cannot be reassigned');
    }
    this.records.set(scopeKey(record.scope), cloneRecord(record));
  }

  async get(scope: VaultScope, ownerUserId: string) {
    const record = this.records.get(scopeKey(scope));
    return record === undefined || record.ownerUserId !== ownerUserId
      ? undefined
      : cloneRecord(record);
  }

  async delete(scope: VaultScope, ownerUserId: string): Promise<boolean> {
    const record = this.records.get(scopeKey(scope));
    if (record === undefined || record.ownerUserId !== ownerUserId) {
      return false;
    }
    return this.records.delete(scopeKey(scope));
  }
}
