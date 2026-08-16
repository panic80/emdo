import {
  EncryptedVaultPayloadSchema,
  VaultScopeSchema,
  type VaultScope,
} from './crypto.js';
import { z } from 'zod';

import { OpaqueReferenceSchema } from '@emdo/contracts';

const VaultRecordSchema = z.strictObject({
  scope: VaultScopeSchema,
  ownerUserId: OpaqueReferenceSchema,
  payload: EncryptedVaultPayloadSchema,
  createdAt: z.date().refine((value) => Number.isFinite(value.getTime())),
});

export type VaultRecord = z.input<typeof VaultRecordSchema>;

const scopeKey = (rawScope: VaultScope) => {
  const scope = VaultScopeSchema.parse(rawScope);
  return JSON.stringify([
    scope.householdId,
    scope.spaceId,
    scope.provider,
    scope.grantType,
    scope.recordId,
  ]);
};

const cloneRecord = (record: VaultRecord): VaultRecord =>
  (() => {
    const validated = VaultRecordSchema.parse(record);
    return Object.freeze({
      scope: validated.scope,
      ownerUserId: validated.ownerUserId,
      payload: validated.payload,
      createdAt: new Date(validated.createdAt),
    });
  })();

export class InMemoryVaultRepository {
  private readonly records = new Map<string, VaultRecord>();

  async put(record: VaultRecord) {
    const candidate = cloneRecord(record);
    const key = scopeKey(candidate.scope);
    const current = this.records.get(key);
    if (
      current !== undefined &&
      current.ownerUserId !== candidate.ownerUserId
    ) {
      throw new Error('Vault record ownership cannot be reassigned');
    }
    this.records.set(key, candidate);
  }

  async get(scope: VaultScope, ownerUserId: string) {
    const key = scopeKey(scope);
    const owner = OpaqueReferenceSchema.parse(ownerUserId);
    const record = this.records.get(key);
    return record === undefined || record.ownerUserId !== owner
      ? undefined
      : cloneRecord(record);
  }

  async delete(scope: VaultScope, ownerUserId: string): Promise<boolean> {
    const key = scopeKey(scope);
    const owner = OpaqueReferenceSchema.parse(ownerUserId);
    const record = this.records.get(key);
    if (record === undefined || record.ownerUserId !== owner) {
      return false;
    }
    return this.records.delete(key);
  }
}
