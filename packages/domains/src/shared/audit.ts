export interface AuditEvent<Payload = Readonly<Record<string, unknown>>> {
  readonly id: string;
  readonly householdId: string;
  readonly actorUserId: string | null;
  readonly eventType: string;
  readonly occurredAt: string;
  readonly payload: Payload;
}

const deepFreeze = <Value>(value: Value): Value => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
};

const cloneAndFreeze = <Value>(value: Value): Value => {
  if (typeof structuredClone !== 'function') {
    throw new Error('structuredClone is required for the audit ledger');
  }
  const cloned = structuredClone(value);
  return deepFreeze(cloned);
};

/** Append-only by interface: there are intentionally no update/delete APIs. */
export class InMemoryAuditLedger {
  readonly #events: AuditEvent[] = [];
  readonly #ids = new Set<string>();

  append<Payload>(event: AuditEvent<Payload>): AuditEvent<Payload> {
    if (this.#ids.has(event.id)) {
      throw new Error(`Audit event ${event.id} already exists`);
    }

    const persisted = Object.freeze({
      ...event,
      payload: cloneAndFreeze(event.payload),
    });
    this.#ids.add(event.id);
    this.#events.push(persisted as AuditEvent);
    return persisted;
  }

  list(): readonly AuditEvent[] {
    return Object.freeze([...this.#events]);
  }
}
