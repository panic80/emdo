import { z } from 'zod';

import {
  IdentifierSchema,
  IsoDateTimeSchema,
  JsonValueSchema,
  OpaqueReferenceSchema,
  deepFreeze,
} from '@emdo/contracts';

const AuditEventSchema = z
  .strictObject({
    id: OpaqueReferenceSchema,
    householdId: OpaqueReferenceSchema,
    actorUserId: OpaqueReferenceSchema.nullable(),
    eventType: IdentifierSchema,
    occurredAt: IsoDateTimeSchema,
    payload: JsonValueSchema,
  })
  .transform(deepFreeze);

export type AuditEvent = z.input<typeof AuditEventSchema>;

/** Append-only by interface: there are intentionally no update/delete APIs. */
export class InMemoryAuditLedger {
  readonly #events: AuditEvent[] = [];
  readonly #ids = new Set<string>();

  append(event: AuditEvent): AuditEvent {
    const persisted = AuditEventSchema.parse(event);
    if (this.#ids.has(persisted.id)) {
      throw new Error(`Audit event ${persisted.id} already exists`);
    }

    this.#ids.add(persisted.id);
    this.#events.push(persisted);
    return persisted;
  }

  list(): readonly AuditEvent[] {
    return Object.freeze([...this.#events]);
  }
}
