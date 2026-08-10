import { getTableName } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import {
  actionDecisions,
  actionProposals,
  agentRuns,
  auditEvents,
  authAccounts,
  authPasskeys,
  authRateLimits,
  authSessions,
  authUsers,
  authVerifications,
  conversationEvents,
  deploymentBootstraps,
  disclosureGrants,
  foundationTables,
  householdMemberships,
  households,
  invitations,
  memoryChunks,
  proposalEvents,
  proposalReconciliations,
  proposalStates,
  providerAttempts,
  providerOutcomes,
  rotatingSessions,
  spaceRecords,
  spaces,
} from './schema.js';

describe('Drizzle household schema', () => {
  it('exports every durable foundation table', () => {
    expect(Object.keys(foundationTables).sort()).toEqual(
      [
        actionDecisions,
        actionProposals,
        agentRuns,
        auditEvents,
        authAccounts,
        authPasskeys,
        authRateLimits,
        authSessions,
        authUsers,
        authVerifications,
        conversationEvents,
        deploymentBootstraps,
        disclosureGrants,
        householdMemberships,
        households,
        invitations,
        memoryChunks,
        proposalEvents,
        proposalReconciliations,
        proposalStates,
        providerAttempts,
        providerOutcomes,
        rotatingSessions,
        spaceRecords,
        spaces,
      ]
        .map(getTableName)
        .sort(),
    );
  });

  it('defines tenant-aware space and original-owner foreign keys', () => {
    const recordConfig = getTableConfig(spaceRecords);
    const references = recordConfig.foreignKeys.map((foreignKey) => {
      const reference = foreignKey.reference();
      return {
        columns: reference.columns.map((column) => column.name),
        foreignColumns: reference.foreignColumns.map((column) => column.name),
        foreignTable: getTableName(reference.foreignTable),
      };
    });

    expect(references).toEqual(
      expect.arrayContaining([
        {
          columns: ['household_id', 'space_id'],
          foreignColumns: ['household_id', 'id'],
          foreignTable: 'spaces',
        },
        {
          columns: ['household_id', 'original_owner_user_id'],
          foreignColumns: ['household_id', 'user_id'],
          foreignTable: 'household_memberships',
        },
      ]),
    );
  });

  it('indexes every scope-bearing child by household and space', () => {
    for (const table of [
      spaceRecords,
      conversationEvents,
      auditEvents,
      agentRuns,
      actionProposals,
      actionDecisions,
      providerAttempts,
      memoryChunks,
    ]) {
      const config = getTableConfig(table);
      expect(
        config.indexes.some((index) => {
          const columns = index.config.columns.map((column) =>
            'name' in column ? column.name : undefined,
          );
          return columns[0] === 'household_id' && columns[1] === 'space_id';
        }),
        `${getTableName(table)} is missing its household/space index`,
      ).toBe(true);
    }
  });

  it('persists provider writes as prepared attempts before dispatch', () => {
    const config = getTableConfig(providerAttempts);
    const dispatchedAt = config.columns.find(
      (column) => column.name === 'dispatched_at',
    );

    expect(config.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        'attempt_state',
        'binding_hash',
        'provider_idempotency_key',
        'idempotency_expires_at',
      ]),
    );
    expect(dispatchedAt?.notNull).toBe(false);
    expect(
      config.uniqueConstraints.map((constraint) => constraint.name),
    ).toEqual(
      expect.arrayContaining([
        'provider_attempts_proposal_unique',
        'provider_attempts_decision_unique',
      ]),
    );
  });
});
