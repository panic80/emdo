import { createHash } from 'node:crypto';

import { OpaqueReferenceSchema, deepFreeze } from '@emdo/contracts';
import { z } from 'zod';

import {
  EncryptedVaultPayloadSchema,
  VaultCrypto,
  VaultScopeSchema,
  type EncryptedVaultPayload,
  type VaultScope,
} from '../../vault/crypto.js';
import {
  GoogleCalendarCredentialSchema,
  type GoogleCalendarCredential,
  type GoogleCalendarCredentialVault,
  type GoogleCalendarOAuthActor,
} from './service.js';

const ActorSchema = z.strictObject({
  userId: OpaqueReferenceSchema,
  householdId: OpaqueReferenceSchema,
  privateSpaceId: OpaqueReferenceSchema,
  sessionId: OpaqueReferenceSchema,
});

const GrantReferenceSchema = OpaqueReferenceSchema.min(16).max(160);

const RecordSchema = z.strictObject({
  scope: VaultScopeSchema,
  ownerUserId: OpaqueReferenceSchema,
  revision: z.number().int().safe().positive(),
  authorizationEpoch: z.number().int().safe().nonnegative(),
  providerGrantReference: GrantReferenceSchema,
  payload: EncryptedVaultPayloadSchema,
  createdAt: z.date().refine((value) => Number.isFinite(value.getTime())),
  updatedAt: z.date().refine((value) => Number.isFinite(value.getTime())),
});

const GrantPayloadSchema = z.strictObject({
  authorizationEpoch: z.number().int().safe().nonnegative(),
  credential: GoogleCalendarCredentialSchema,
});

const isBoundedPlainData = (input: unknown): boolean => {
  const pending: Array<{ value: unknown; depth: number; exit?: true }> = [
    { value: input, depth: 0 },
  ];
  const active = new WeakSet<object>();
  let count = 0;
  try {
    while (pending.length > 0) {
      const item = pending.pop()!;
      count += 1;
      if (count > 512 || item.depth > 10) return false;
      if (item.exit) {
        if (item.value !== null && typeof item.value === 'object') {
          active.delete(item.value);
        }
        continue;
      }
      if (item.value === null || typeof item.value !== 'object') continue;
      const prototype = Object.getPrototypeOf(item.value);
      if (prototype === Date.prototype) {
        if (!Number.isFinite(Date.prototype.getTime.call(item.value))) {
          return false;
        }
        continue;
      }
      if (active.has(item.value)) return false;
      if (
        !Array.isArray(item.value) &&
        prototype !== Object.prototype &&
        prototype !== null
      ) {
        return false;
      }
      active.add(item.value);
      pending.push({ value: item.value, depth: item.depth, exit: true });
      for (const descriptor of Object.values(
        Object.getOwnPropertyDescriptors(item.value),
      )) {
        if (descriptor.get !== undefined || descriptor.set !== undefined) {
          return false;
        }
        pending.push({ value: descriptor.value, depth: item.depth + 1 });
      }
    }
  } catch {
    return false;
  }
  return true;
};

const parseActor = (input: unknown): GoogleCalendarOAuthActor => {
  if (!isBoundedPlainData(input))
    throw new Error('OAuth actor must be plain data');
  return deepFreeze(ActorSchema.parse(input));
};

const scopeFor = (actor: GoogleCalendarOAuthActor): VaultScope =>
  VaultScopeSchema.parse({
    householdId: actor.householdId,
    spaceId: actor.privateSpaceId,
    recordId: `google-calendar-oauth-v1-${createHash('sha256')
      .update(actor.userId)
      .digest('hex')}`,
    provider: 'google',
    grantType: 'calendar-authorization',
  });

const exactScope = (left: VaultScope, right: VaultScope): boolean =>
  left.householdId === right.householdId &&
  left.spaceId === right.spaceId &&
  left.recordId === right.recordId &&
  left.provider === right.provider &&
  left.grantType === right.grantType;

export interface EncryptedGoogleCalendarGrantRecord {
  readonly scope: VaultScope;
  readonly ownerUserId: string;
  readonly revision: number;
  readonly authorizationEpoch: number;
  readonly providerGrantReference: string;
  readonly payload: EncryptedVaultPayload;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface EncryptedGoogleCalendarGrantStore {
  load(input: {
    readonly scope: VaultScope;
    readonly ownerUserId: string;
  }): Promise<EncryptedGoogleCalendarGrantRecord | undefined>;
  compareAndSet(input: {
    readonly scope: VaultScope;
    readonly ownerUserId: string;
    readonly expectedRevision: number | null;
    readonly authorizationEpoch: number;
    readonly providerGrantReference: string;
    readonly payload: EncryptedVaultPayload;
    readonly now: Date;
  }): Promise<
    | { readonly status: 'stored'; readonly revision: number }
    | { readonly status: 'conflict' }
  >;
  delete(input: {
    readonly scope: VaultScope;
    readonly ownerUserId: string;
    readonly expectedRevision: number;
  }): Promise<boolean>;
}

export class EncryptedGoogleCalendarCredentialVault implements GoogleCalendarCredentialVault {
  readonly #crypto: VaultCrypto;
  readonly #store: EncryptedGoogleCalendarGrantStore;
  readonly #clock: () => Date;

  constructor(options: {
    readonly crypto: VaultCrypto;
    readonly store: EncryptedGoogleCalendarGrantStore;
    readonly clock: () => Date;
  }) {
    this.#crypto = options.crypto;
    this.#store = options.store;
    this.#clock = options.clock;
  }

  async load(actorInput: GoogleCalendarOAuthActor) {
    const actor = parseActor(actorInput);
    const scope = scopeFor(actor);
    const rawRecord = await this.#store.load({
      scope,
      ownerUserId: actor.userId,
    });
    if (rawRecord === undefined) return undefined;
    if (!isBoundedPlainData(rawRecord)) {
      throw new Error('Encrypted Calendar grant record must be plain data');
    }
    const record = RecordSchema.parse(rawRecord);
    if (
      record.ownerUserId !== actor.userId ||
      !exactScope(record.scope, scope) ||
      record.payload.ciphertext.length > 32_768
    ) {
      throw new Error('Encrypted Calendar grant record scope mismatch');
    }
    const plaintext = await this.#crypto.decrypt(record.payload, scope);
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(plaintext);
    } catch {
      throw new Error('Encrypted Calendar grant payload is invalid');
    }
    if (!isBoundedPlainData(parsedJson)) {
      throw new Error('Encrypted Calendar grant payload must be plain data');
    }
    const grantPayload = GrantPayloadSchema.parse(parsedJson);
    if (grantPayload.authorizationEpoch !== record.authorizationEpoch) {
      throw new Error('Encrypted Calendar grant epoch mismatch');
    }
    if (
      grantPayload.credential.grantReference !== record.providerGrantReference
    ) {
      throw new Error('Encrypted Calendar grant reference mismatch');
    }
    const credential = deepFreeze(grantPayload.credential);
    return deepFreeze({
      revision: record.revision,
      authorizationEpoch: record.authorizationEpoch,
      credential,
    });
  }

  async compareAndSet(input: {
    readonly actor: GoogleCalendarOAuthActor;
    readonly expectedRevision: number | null;
    readonly authorizationEpoch: number;
    readonly credential: GoogleCalendarCredential;
  }) {
    if (!isBoundedPlainData(input)) {
      throw new Error('Calendar credential write must be plain data');
    }
    const actor = parseActor(input.actor);
    const expectedRevision = z
      .number()
      .int()
      .safe()
      .positive()
      .nullable()
      .parse(input.expectedRevision);
    const credential = deepFreeze(
      GoogleCalendarCredentialSchema.parse(input.credential),
    );
    const authorizationEpoch = z
      .number()
      .int()
      .safe()
      .nonnegative()
      .parse(input.authorizationEpoch);
    const scope = scopeFor(actor);
    const payload = await this.#crypto.encrypt(
      JSON.stringify({ authorizationEpoch, credential }),
      scope,
    );
    const now = this.#clock();
    if (!Number.isFinite(now.getTime())) throw new Error('Invalid vault clock');
    return this.#store.compareAndSet({
      scope,
      ownerUserId: actor.userId,
      expectedRevision,
      authorizationEpoch,
      providerGrantReference: credential.grantReference,
      payload,
      now: new Date(now),
    });
  }

  async delete(input: {
    readonly actor: GoogleCalendarOAuthActor;
    readonly expectedRevision: number;
  }): Promise<boolean> {
    if (!isBoundedPlainData(input)) {
      throw new Error('Calendar credential deletion must be plain data');
    }
    const actor = parseActor(input.actor);
    const expectedRevision = z
      .number()
      .int()
      .safe()
      .positive()
      .parse(input.expectedRevision);
    return this.#store.delete({
      scope: scopeFor(actor),
      ownerUserId: actor.userId,
      expectedRevision,
    });
  }
}
