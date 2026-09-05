import { describe, expect, it } from 'vitest';

import {
  createRlsCrossHouseholdProbe,
  parseRlsCrossHouseholdProbe,
} from './rls-cross-household-probe.js';

const sourceSha = 'a'.repeat(40);
const context = Object.freeze({
  environment: 'ci' as const,
  event: 'push' as const,
  runId: '1234',
  sourceSha,
  workflow: '.github/workflows/ci.yml' as const,
});
const input = () => ({
  context,
  database: {
    postgresqlMajor: 18 as const,
    serverVersionNum: 180_010,
    pgvectorExtensionVersion: '0.8.6',
  },
  observedAt: '2026-08-10T14:00:00.000Z',
  proof: {
    attackCaseCount: 15,
    crossHouseholdReadDenied: true as const,
    crossHouseholdWriteDenied: true as const,
    privateOwnerBypassDenied: true as const,
    signedClaimScope: 'passed' as const,
  },
});

describe('RLS cross-household live probe envelope', () => {
  it('binds a successful live proof to its exact CI workflow run and database', () => {
    const probe = createRlsCrossHouseholdProbe(input());

    expect(probe).toEqual({
      schemaVersion: 1,
      evidenceClass: 'live-postgres-rls-probe',
      releaseEligible: false,
      environment: 'ci',
      sourceSha,
      observedAt: '2026-08-10T14:00:00.000Z',
      execution: {
        workflow: '.github/workflows/ci.yml',
        runId: '1234',
        event: 'push',
      },
      database: input().database,
      proof: input().proof,
    });
    expect(parseRlsCrossHouseholdProbe(probe, context)).toEqual(probe);
  });

  it.each([
    ['another run', { execution: { ...context, runId: '9999' } }],
    [
      'an unsuccessful attack',
      {
        proof: {
          ...input().proof,
          crossHouseholdWriteDenied: false,
        },
      },
    ],
    [
      'an incomplete attack set',
      { proof: { ...input().proof, attackCaseCount: 14 } },
    ],
    [
      'a PostgreSQL 17 database',
      {
        database: {
          ...input().database,
          postgresqlMajor: 17,
          serverVersionNum: 170_010,
        },
      },
    ],
    [
      'a PostgreSQL 19 database',
      {
        database: {
          ...input().database,
          postgresqlMajor: 19,
          serverVersionNum: 190_000,
        },
      },
    ],
    ['an extra field', { synthesized: true }],
  ])('rejects %s', (_name, patch) => {
    const probe = {
      ...createRlsCrossHouseholdProbe(input()),
      ...patch,
    };
    expect(() => parseRlsCrossHouseholdProbe(probe, context)).toThrow(
      'RLS cross-household live probe is invalid',
    );
  });
});
