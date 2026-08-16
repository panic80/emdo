import { createHash } from 'node:crypto';

export const SPEND_WARNING_CAD_MINOR = 5_000;
export const SPEND_LIMIT_CAD_MINOR = 7_500;

export type SpendCategory = 'model' | 'audio' | 'deterministic';

export interface SpendAuthorization {
  readonly authorizationId: string;
  readonly category: SpendCategory;
  readonly householdId: string;
}

export interface SpendAuthorizationResolver {
  resolve(executionId: string): Promise<SpendAuthorization | undefined>;
}

export type SpendReservationResult =
  | Readonly<{
      status: 'not-metered';
      warning: false;
      period: string;
    }>
  | Readonly<{
      status: 'reserved';
      warning: boolean;
      period: string;
      projectedCadMinor: number;
      reservationId: string;
    }>
  | Readonly<{
      status: 'blocked';
      warning: true;
      period: string;
      currentCadMinor: number;
      safeError: Readonly<{
        code: 'monthly-ai-spend-limit-reached';
        message: 'The monthly AI spend limit has been reached.';
        retryable: false;
      }>;
    }>
  | Readonly<{
      status: 'released';
      period: string;
      reservationId: string;
    }>
  | Readonly<{
      status: 'dispatched';
      period: string;
      reservationId: string;
    }>
  | Readonly<{
      status: 'settled';
      period: string;
      reservationId: string;
      actualCadMinor: number;
      reservationExceeded: boolean;
    }>;

interface MeteredReservationRequest {
  readonly authorizationHash: string;
  readonly category: 'model' | 'audio';
  readonly estimatedCadMinor: number;
  readonly executionId: string;
  readonly householdId: string;
  readonly period: string;
  readonly requestHash: string;
  readonly reservationId: string;
}

export interface SpendLedger {
  reserve(
    request: MeteredReservationRequest,
    thresholds: Readonly<{ warningCadMinor: number; limitCadMinor: number }>,
  ): Promise<SpendReservationResult>;
  markDispatched(input: {
    readonly reservationId: string;
    readonly authorizationHash: string;
  }): Promise<SpendReservationResult>;
  settle(input: {
    readonly reservationId: string;
    readonly executionId: string;
    readonly actualCadMinor: number;
  }): Promise<SpendReservationResult>;
  release(input: {
    readonly reservationId: string;
    readonly authorizationHash: string;
  }): Promise<SpendReservationResult>;
}

const validIdentifier = (value: string) =>
  value.length >= 16 && value.length <= 200 && /^[A-Za-z0-9:._-]+$/.test(value);

const snapshotDataObject = (
  input: unknown,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> => {
  try {
    if (
      input === null ||
      typeof input !== 'object' ||
      (Object.getPrototypeOf(input) !== Object.prototype &&
        Object.getPrototypeOf(input) !== null)
    ) {
      throw new Error('invalid');
    }
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = Reflect.ownKeys(input);
    if (
      keys.length !== expectedKeys.length ||
      !keys.every(
        (key) => typeof key === 'string' && expectedKeys.includes(key),
      )
    ) {
      throw new Error('invalid');
    }
    const snapshot: Record<string, unknown> = {};
    for (const key of expectedKeys) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        descriptor.enumerable !== true
      ) {
        throw new Error('invalid');
      }
      snapshot[key] = descriptor.value as unknown;
    }
    return Object.freeze(snapshot);
  } catch {
    throw new Error('invalid-spend-request');
  }
};

const assertMinorUnits = (value: number) => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('invalid-spend-request');
  }
};

export const torontoMonth = (now: Date): string => {
  if (!Number.isFinite(now.getTime())) {
    throw new Error('invalid-spend-request');
  }
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  if (year === undefined || month === undefined) {
    throw new Error('invalid-spend-request');
  }
  return `${year}-${month}`;
};

const hashJson = (value: Readonly<Record<string, string | number>>) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

const validateAuthorization = (
  executionId: string,
  authorization: SpendAuthorization | undefined,
): Readonly<SpendAuthorization> => {
  if (
    authorization === undefined ||
    (Object.getPrototypeOf(authorization) !== Object.prototype &&
      Object.getPrototypeOf(authorization) !== null)
  ) {
    throw new Error('spend-authorization-denied');
  }
  const descriptors = Object.getOwnPropertyDescriptors(authorization);
  const ownKeys = Reflect.ownKeys(authorization);
  if (
    ownKeys.length !== 3 ||
    !ownKeys.every(
      (key) =>
        typeof key === 'string' &&
        ['authorizationId', 'category', 'householdId'].includes(key),
    ) ||
    descriptors.authorizationId?.get !== undefined ||
    descriptors.authorizationId?.set !== undefined ||
    descriptors.category?.get !== undefined ||
    descriptors.category?.set !== undefined ||
    descriptors.householdId?.get !== undefined ||
    descriptors.householdId?.set !== undefined
  ) {
    throw new Error('spend-authorization-denied');
  }
  const snapshot = {
    authorizationId: descriptors.authorizationId?.value as unknown,
    category: descriptors.category?.value as unknown,
    householdId: descriptors.householdId?.value as unknown,
  };
  if (
    !validIdentifier(executionId) ||
    typeof snapshot.authorizationId !== 'string' ||
    !validIdentifier(snapshot.authorizationId) ||
    typeof snapshot.householdId !== 'string' ||
    !validIdentifier(snapshot.householdId) ||
    typeof snapshot.category !== 'string' ||
    !['audio', 'deterministic', 'model'].includes(snapshot.category)
  ) {
    throw new Error('spend-authorization-denied');
  }
  return Object.freeze(snapshot as SpendAuthorization);
};

const authorizationHash = (
  executionId: string,
  authorization: SpendAuthorization,
) =>
  hashJson({
    authorizationId: authorization.authorizationId,
    category: authorization.category,
    executionId,
    householdId: authorization.householdId,
  });

export class SpendGuard {
  private readonly resolveAuthorization: SpendAuthorizationResolver['resolve'];
  private readonly reserveSpend: SpendLedger['reserve'];
  private readonly markSpendDispatched: SpendLedger['markDispatched'];
  private readonly settleSpend: SpendLedger['settle'];
  private readonly releaseSpend: SpendLedger['release'];
  private readonly clock: () => Date;

  constructor(
    ledger: SpendLedger,
    resolver: SpendAuthorizationResolver,
    clock: () => Date = () => new Date(),
  ) {
    if (
      typeof ledger.reserve !== 'function' ||
      typeof ledger.markDispatched !== 'function' ||
      typeof ledger.settle !== 'function' ||
      typeof ledger.release !== 'function' ||
      typeof resolver.resolve !== 'function' ||
      typeof clock !== 'function'
    ) {
      throw new Error('invalid-spend-guard-dependency');
    }
    this.resolveAuthorization = resolver.resolve.bind(resolver);
    this.reserveSpend = ledger.reserve.bind(ledger);
    this.markSpendDispatched = ledger.markDispatched.bind(ledger);
    this.settleSpend = ledger.settle.bind(ledger);
    this.releaseSpend = ledger.release.bind(ledger);
    this.clock = clock;
  }

  async reserve(input: {
    readonly executionId: string;
    readonly reservationId: string;
    readonly estimatedCadMinor: number;
  }): Promise<SpendReservationResult> {
    const snapshot = snapshotDataObject(input, [
      'executionId',
      'reservationId',
      'estimatedCadMinor',
    ]);
    const executionId = snapshot.executionId;
    const reservationId = snapshot.reservationId;
    const estimatedCadMinor = snapshot.estimatedCadMinor;
    if (typeof reservationId !== 'string' || !validIdentifier(reservationId)) {
      throw new Error('invalid-spend-request');
    }
    if (typeof executionId !== 'string' || !validIdentifier(executionId)) {
      throw new Error('spend-authorization-denied');
    }
    if (typeof estimatedCadMinor !== 'number') {
      throw new Error('invalid-spend-request');
    }
    assertMinorUnits(estimatedCadMinor);
    const authorization = validateAuthorization(
      executionId,
      await this.resolveAuthorization(executionId),
    );
    const period = torontoMonth(new Date(this.clock()));

    if (authorization.category === 'deterministic') {
      return Object.freeze({
        status: 'not-metered' as const,
        warning: false as const,
        period,
      });
    }
    if (estimatedCadMinor === 0) {
      throw new Error('invalid-spend-request');
    }

    const authorizationDigest = authorizationHash(executionId, authorization);
    const requestWithoutHash = {
      authorizationHash: authorizationDigest,
      category: authorization.category,
      estimatedCadMinor,
      executionId,
      householdId: authorization.householdId,
      period,
      reservationId,
    };
    const request: MeteredReservationRequest = Object.freeze({
      ...requestWithoutHash,
      requestHash: hashJson(requestWithoutHash),
    });
    return this.reserveSpend(request, {
      warningCadMinor: SPEND_WARNING_CAD_MINOR,
      limitCadMinor: SPEND_LIMIT_CAD_MINOR,
    });
  }

  async settle(input: {
    readonly executionId: string;
    readonly reservationId: string;
    readonly actualCadMinor: number;
  }): Promise<SpendReservationResult> {
    const snapshot = snapshotDataObject(input, [
      'executionId',
      'reservationId',
      'actualCadMinor',
    ]);
    const executionId = snapshot.executionId;
    const reservationId = snapshot.reservationId;
    const actualCadMinor = snapshot.actualCadMinor;
    if (typeof reservationId !== 'string' || !validIdentifier(reservationId)) {
      throw new Error('invalid-spend-request');
    }
    if (typeof executionId !== 'string' || !validIdentifier(executionId)) {
      throw new Error('spend-authorization-denied');
    }
    if (typeof actualCadMinor !== 'number') {
      throw new Error('invalid-spend-request');
    }
    assertMinorUnits(actualCadMinor);
    // This is a server-only metering boundary. The durable ledger binds the
    // exact execution at reservation time so post-dispatch billing survives
    // user/session revocation without accepting caller-supplied scope.
    return this.settleSpend({
      reservationId,
      executionId,
      actualCadMinor,
    });
  }

  async markDispatched(input: {
    readonly executionId: string;
    readonly reservationId: string;
  }): Promise<SpendReservationResult> {
    const snapshot = snapshotDataObject(input, [
      'executionId',
      'reservationId',
    ]);
    const executionId = snapshot.executionId;
    const reservationId = snapshot.reservationId;
    if (typeof reservationId !== 'string' || !validIdentifier(reservationId)) {
      throw new Error('invalid-spend-request');
    }
    if (typeof executionId !== 'string' || !validIdentifier(executionId)) {
      throw new Error('spend-authorization-denied');
    }
    const authorization = validateAuthorization(
      executionId,
      await this.resolveAuthorization(executionId),
    );
    if (authorization.category === 'deterministic') {
      throw new Error('spend-reservation-authorization-mismatch');
    }
    return this.markSpendDispatched({
      reservationId,
      authorizationHash: authorizationHash(executionId, authorization),
    });
  }

  async release(input: {
    readonly executionId: string;
    readonly reservationId: string;
  }): Promise<SpendReservationResult> {
    const snapshot = snapshotDataObject(input, [
      'executionId',
      'reservationId',
    ]);
    const executionId = snapshot.executionId;
    const reservationId = snapshot.reservationId;
    if (typeof reservationId !== 'string' || !validIdentifier(reservationId)) {
      throw new Error('invalid-spend-request');
    }
    if (typeof executionId !== 'string' || !validIdentifier(executionId)) {
      throw new Error('spend-authorization-denied');
    }
    const authorization = validateAuthorization(
      executionId,
      await this.resolveAuthorization(executionId),
    );
    if (authorization.category === 'deterministic') {
      throw new Error('spend-reservation-authorization-mismatch');
    }
    return this.releaseSpend({
      reservationId,
      authorizationHash: authorizationHash(executionId, authorization),
    });
  }
}

type StoredReservationState =
  'blocked' | 'reserved' | 'dispatched' | 'settled' | 'released';

interface StoredReservation {
  readonly request: MeteredReservationRequest;
  result: SpendReservationResult;
  state: StoredReservationState;
  actualCadMinor?: number;
}

const periodKey = (householdId: string, period: string) =>
  `${householdId}\u0000${period}`;

export class InMemorySpendLedger implements SpendLedger {
  readonly #reservations = new Map<string, StoredReservation>();
  readonly #committed = new Map<string, number>();
  readonly #reserved = new Map<string, number>();

  async reserve(
    request: MeteredReservationRequest,
    thresholds: Readonly<{ warningCadMinor: number; limitCadMinor: number }>,
  ): Promise<SpendReservationResult> {
    const replay = this.#reservations.get(request.reservationId);
    if (replay !== undefined) {
      if (replay.request.requestHash !== request.requestHash) {
        throw new Error('spend-reservation-idempotency-conflict');
      }
      return replay.result;
    }

    const key = periodKey(request.householdId, request.period);
    const committed = this.#committed.get(key) ?? 0;
    const reserved = this.#reserved.get(key) ?? 0;
    const current = committed + reserved;
    const projected = current + request.estimatedCadMinor;
    if (!Number.isSafeInteger(current) || !Number.isSafeInteger(projected)) {
      throw new Error('spend-ledger-overflow');
    }

    if (
      current >= thresholds.limitCadMinor ||
      projected > thresholds.limitCadMinor
    ) {
      const result = Object.freeze({
        status: 'blocked' as const,
        warning: true as const,
        period: request.period,
        currentCadMinor: current,
        safeError: Object.freeze({
          code: 'monthly-ai-spend-limit-reached' as const,
          message: 'The monthly AI spend limit has been reached.' as const,
          retryable: false as const,
        }),
      });
      this.#reservations.set(request.reservationId, {
        request,
        result,
        state: 'blocked',
      });
      return result;
    }

    const result = Object.freeze({
      status: 'reserved' as const,
      warning: projected >= thresholds.warningCadMinor,
      period: request.period,
      projectedCadMinor: projected,
      reservationId: request.reservationId,
    });
    this.#reserved.set(key, reserved + request.estimatedCadMinor);
    this.#reservations.set(request.reservationId, {
      request,
      result,
      state: 'reserved',
    });
    return result;
  }

  async markDispatched(input: {
    readonly reservationId: string;
    readonly authorizationHash: string;
  }): Promise<SpendReservationResult> {
    const reservation = this.#reservations.get(input.reservationId);
    if (reservation === undefined || reservation.state === 'blocked') {
      throw new Error('spend-reservation-not-active');
    }
    if (reservation.request.authorizationHash !== input.authorizationHash) {
      throw new Error('spend-reservation-authorization-mismatch');
    }
    if (reservation.state === 'released') {
      throw new Error('released-spend-reservation-cannot-be-dispatched');
    }
    if (reservation.state === 'dispatched' || reservation.state === 'settled') {
      return reservation.result;
    }
    const result = Object.freeze({
      status: 'dispatched' as const,
      period: reservation.request.period,
      reservationId: reservation.request.reservationId,
    });
    reservation.state = 'dispatched';
    reservation.result = result;
    return result;
  }

  async settle(input: {
    readonly reservationId: string;
    readonly executionId: string;
    readonly actualCadMinor: number;
  }): Promise<SpendReservationResult> {
    const reservation = this.#reservations.get(input.reservationId);
    if (reservation === undefined || reservation.state === 'blocked') {
      throw new Error('spend-reservation-not-active');
    }
    if (reservation.request.executionId !== input.executionId) {
      throw new Error('spend-reservation-authorization-mismatch');
    }
    if (reservation.state === 'settled') {
      if (reservation.actualCadMinor !== input.actualCadMinor) {
        throw new Error('spend-settlement-idempotency-conflict');
      }
      return reservation.result;
    }
    const key = periodKey(
      reservation.request.householdId,
      reservation.request.period,
    );
    const wasActive =
      reservation.state === 'reserved' || reservation.state === 'dispatched';
    const nextReserved =
      (this.#reserved.get(key) ?? 0) -
      (wasActive ? reservation.request.estimatedCadMinor : 0);
    const nextCommitted =
      (this.#committed.get(key) ?? 0) + input.actualCadMinor;
    if (
      !Number.isSafeInteger(nextReserved) ||
      nextReserved < 0 ||
      !Number.isSafeInteger(nextCommitted)
    ) {
      throw new Error('spend-ledger-overflow');
    }
    const result = Object.freeze({
      status: 'settled' as const,
      period: reservation.request.period,
      reservationId: reservation.request.reservationId,
      actualCadMinor: input.actualCadMinor,
      reservationExceeded:
        input.actualCadMinor > reservation.request.estimatedCadMinor,
    });
    this.#reserved.set(key, nextReserved);
    this.#committed.set(key, nextCommitted);
    reservation.state = 'settled';
    reservation.actualCadMinor = input.actualCadMinor;
    reservation.result = result;
    return result;
  }

  async release(input: {
    readonly reservationId: string;
    readonly authorizationHash: string;
  }): Promise<SpendReservationResult> {
    const reservation = this.#reservations.get(input.reservationId);
    if (reservation === undefined || reservation.state === 'blocked') {
      throw new Error('spend-reservation-not-active');
    }
    if (reservation.request.authorizationHash !== input.authorizationHash) {
      throw new Error('spend-reservation-authorization-mismatch');
    }
    if (reservation.state === 'released') return reservation.result;
    if (reservation.state === 'settled') {
      throw new Error('settled-spend-reservation-cannot-be-released');
    }
    if (reservation.state === 'dispatched') {
      throw new Error('dispatched-spend-reservation-cannot-be-released');
    }
    const key = periodKey(
      reservation.request.householdId,
      reservation.request.period,
    );
    const nextReserved =
      (this.#reserved.get(key) ?? 0) - reservation.request.estimatedCadMinor;
    if (!Number.isSafeInteger(nextReserved) || nextReserved < 0) {
      throw new Error('spend-ledger-overflow');
    }
    const result = Object.freeze({
      status: 'released' as const,
      period: reservation.request.period,
      reservationId: reservation.request.reservationId,
    });
    this.#reserved.set(key, nextReserved);
    reservation.state = 'released';
    reservation.result = result;
    return result;
  }

  async total(householdId: string, period: string): Promise<number> {
    return this.#committed.get(periodKey(householdId, period)) ?? 0;
  }
}

export class InMemorySpendAuthorizationResolver implements SpendAuthorizationResolver {
  readonly #authorizations = new Map<string, SpendAuthorization>();

  constructor(initial: Readonly<Record<string, SpendAuthorization>> = {}) {
    for (const [executionId, authorization] of Object.entries(initial)) {
      this.set(executionId, authorization);
    }
  }

  set(executionId: string, authorization: SpendAuthorization): void {
    this.#authorizations.set(executionId, Object.freeze({ ...authorization }));
  }

  async resolve(executionId: string): Promise<SpendAuthorization | undefined> {
    const authorization = this.#authorizations.get(executionId);
    return authorization === undefined
      ? undefined
      : Object.freeze({ ...authorization });
  }
}
