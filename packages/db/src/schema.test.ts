import { getTableName } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import {
  actionDecisions,
  actionProposals,
  agentRunEvents,
  agentRuns,
  aiSpendReservations,
  approvalCheckpoints,
  approvalResumeJobs,
  audioRequestClaimOutcomes,
  audioRequestReceiptOperations,
  audioRequestReceipts,
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
  encryptedGoogleCalendarGrants,
  financeDocumentChunks,
  financeDocumentEvidence,
  financeDocumentExtractions,
  financeDocumentMatches,
  financeDocumentReviewBatches,
  financeDocuments,
  financeImportFingerprints,
  financeImportPlans,
  financeImportReceipts,
  financeSpecialistRecordReceipts,
  foundationTables,
  householdAdministrationCommands,
  householdMemberships,
  households,
  googleOAuthAuthorizationEpochs,
  googleOAuthAuthorizationStarts,
  googleOAuthDisconnectOperations,
  googleOAuthFlows,
  invitations,
  invitationDeliverySecrets,
  invitationRedemptionCommands,
  managerTurnOperations,
  managerTurns,
  memoryChunks,
  proposalEvents,
  proposalPreparations,
  proposalReconciliations,
  proposalStates,
  providerAttempts,
  providerOutcomes,
  rotatingSessions,
  calendarMaintenanceReceipts,
  calendarSyncStates,
  notificationDeliveries,
  notificationPreferenceCommands,
  notificationPreferences,
  notifications,
  schedulerReminders,
  schedulerExecutionReceipts,
  spaceAccessGrants,
  spaceRecords,
  spaces,
  syncApiRequestReceipts,
  syncClients,
  syncEntities,
  syncEntityRevisions,
  syncOperationReceipts,
  workerJobExecutions,
  workerOperationOutbox,
  visualDecisionProofs,
} from './schema.js';

describe('Drizzle household schema', () => {
  it('exports every durable foundation table', () => {
    expect(Object.keys(foundationTables).sort()).toEqual(
      [
        actionDecisions,
        actionProposals,
        agentRunEvents,
        agentRuns,
        aiSpendReservations,
        approvalCheckpoints,
        approvalResumeJobs,
        audioRequestClaimOutcomes,
        audioRequestReceiptOperations,
        audioRequestReceipts,
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
        encryptedGoogleCalendarGrants,
        financeDocumentChunks,
        financeDocumentEvidence,
        financeDocumentExtractions,
        financeDocumentMatches,
        financeDocumentReviewBatches,
        financeDocuments,
        financeImportFingerprints,
        financeImportPlans,
        financeImportReceipts,
        financeSpecialistRecordReceipts,
        householdAdministrationCommands,
        householdMemberships,
        households,
        googleOAuthAuthorizationEpochs,
        googleOAuthAuthorizationStarts,
        googleOAuthDisconnectOperations,
        googleOAuthFlows,
        invitations,
        invitationDeliverySecrets,
        invitationRedemptionCommands,
        managerTurnOperations,
        managerTurns,
        memoryChunks,
        proposalEvents,
        proposalPreparations,
        proposalReconciliations,
        proposalStates,
        providerAttempts,
        providerOutcomes,
        rotatingSessions,
        calendarMaintenanceReceipts,
        calendarSyncStates,
        notificationDeliveries,
        notificationPreferenceCommands,
        notificationPreferences,
        notifications,
        schedulerReminders,
        schedulerExecutionReceipts,
        spaceAccessGrants,
        spaceRecords,
        spaces,
        syncApiRequestReceipts,
        syncClients,
        syncEntities,
        syncEntityRevisions,
        syncOperationReceipts,
        workerJobExecutions,
        workerOperationOutbox,
        visualDecisionProofs,
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

  it('keeps the finance import snapshot tables aligned to their migration-owned keys and checks', () => {
    const planConfig = getTableConfig(financeImportPlans);
    const planReferences = planConfig.foreignKeys.map((foreignKey) => {
      const reference = foreignKey.reference();
      return {
        columns: reference.columns.map((column) => column.name),
        foreignColumns: reference.foreignColumns.map((column) => column.name),
        foreignTable: getTableName(reference.foreignTable),
      };
    });
    expect(planReferences).toEqual(
      expect.arrayContaining([
        {
          columns: ['household_id', 'space_id'],
          foreignColumns: ['household_id', 'id'],
          foreignTable: 'spaces',
        },
        {
          columns: ['household_id', 'owner_user_id'],
          foreignColumns: ['household_id', 'user_id'],
          foreignTable: 'household_memberships',
        },
      ]),
    );
    expect(planConfig.checks.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        'finance_import_plans_source_hash_check',
        'finance_import_plans_plan_hash_check',
        'finance_import_plans_scope_hash_check',
        'finance_import_plans_account_id_check',
        'finance_import_plans_expiry_check',
        'finance_import_plans_plan_size_check',
        'finance_import_plans_diagnostics_size_check',
        'finance_import_plans_mapping_size_check',
      ]),
    );
    expect(
      getTableConfig(financeImportReceipts).checks.map(
        (constraint) => constraint.name,
      ),
    ).toEqual(
      expect.arrayContaining([
        'finance_import_receipts_plan_hash_check',
        'finance_import_receipts_scope_hash_check',
        'finance_import_receipts_account_id_check',
        'finance_import_receipts_key_check',
        'finance_import_receipts_transaction_count_check',
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
      proposalPreparations,
      actionDecisions,
      providerAttempts,
      memoryChunks,
      agentRunEvents,
      approvalCheckpoints,
      approvalResumeJobs,
      managerTurns,
      schedulerExecutionReceipts,
      syncEntities,
      syncOperationReceipts,
      workerOperationOutbox,
      workerJobExecutions,
      schedulerReminders,
      notifications,
      notificationDeliveries,
      calendarSyncStates,
      calendarMaintenanceReceipts,
      encryptedGoogleCalendarGrants,
      googleOAuthAuthorizationEpochs,
      googleOAuthFlows,
      visualDecisionProofs,
    ]) {
      const config = getTableConfig(table);
      expect(
        config.indexes.some((index) => {
          const columns = index.config.columns.map((column) =>
            'name' in column ? column.name : undefined,
          );
          return (
            columns[0] === 'household_id' &&
            (columns[1] === 'space_id' || columns[1] === 'private_space_id')
          );
        }),
        `${getTableName(table)} is missing its household/space index`,
      ).toBe(true);
    }
  });

  it('persists provider writes as prepared attempts before dispatch', () => {
    const proposalConfig = getTableConfig(actionProposals);
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
    expect(proposalConfig.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        'approval_display',
        'authorization_scope_fingerprint',
      ]),
    );
    expect(proposalConfig.checks.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        'action_proposals_approval_display_check',
        'action_proposals_authorization_scope_fingerprint_check',
      ]),
    );
    expect(
      config.uniqueConstraints.map((constraint) => constraint.name),
    ).toEqual(
      expect.arrayContaining([
        'provider_attempts_proposal_unique',
        'provider_attempts_decision_unique',
      ]),
    );
  });

  it('persists approval resume ownership and terminal event lineage', () => {
    const config = getTableConfig(approvalResumeJobs);

    expect(config.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        'approval_event_sequence',
        'disclosure_policy_version',
        'authenticated_session_id',
        'resume_request_id',
        'resume_space_access_grant_id',
        'claimed_at',
        'claim_expires_at',
        'terminal_reason_code',
        'terminal_result_hash',
      ]),
    );
    expect(
      config.uniqueConstraints.map((constraint) => constraint.name),
    ).toEqual(
      expect.arrayContaining([
        'approval_resume_jobs_checkpoint_unique',
        'approval_resume_jobs_ownership_digest_unique',
        'approval_resume_jobs_resume_request_unique',
        'approval_resume_jobs_resume_grant_unique',
      ]),
    );
    expect(config.checks.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        'approval_resume_jobs_state_check',
        'approval_resume_jobs_claim_lifetime_check',
        'approval_resume_jobs_disclosure_policy_version_check',
      ]),
    );

    const references = config.foreignKeys.map((foreignKey) => {
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
          columns: ['authenticated_session_id'],
          foreignColumns: ['id'],
          foreignTable: 'auth_sessions',
        },
        {
          columns: ['resume_space_access_grant_id'],
          foreignColumns: ['grant_id'],
          foreignTable: 'space_access_grants',
        },
        {
          columns: ['run_id', 'approval_event_sequence'],
          foreignColumns: ['run_id', 'sequence'],
          foreignTable: 'agent_run_events',
        },
        {
          columns: ['run_id', 'terminal_event_sequence'],
          foreignColumns: ['run_id', 'sequence'],
          foreignTable: 'agent_run_events',
        },
      ]),
    );
  });

  it('persists manager turns and exact operation readback lineage', () => {
    const turnConfig = getTableConfig(managerTurns);
    const operationConfig = getTableConfig(managerTurnOperations);

    expect(turnConfig.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        'origin_session_id',
        'origin_request_id',
        'origin_space_access_grant_id',
        'origin_collection_authorization_scope_fingerprint',
        'origin_operation_authorization_scope_fingerprint',
        'request_hash',
        'ownership_token_hash',
        'result_hash',
        'terminal_event_sequence',
        'approval_checkpoint_id',
      ]),
    );
    expect(
      turnConfig.uniqueConstraints.map((constraint) => constraint.name),
    ).toEqual(
      expect.arrayContaining([
        'manager_turns_household_user_idempotency_unique',
        'manager_turns_claim_unique',
      ]),
    );
    expect(turnConfig.checks.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        'manager_turns_authority_check',
        'manager_turns_request_check',
        'manager_turns_state_check',
        'manager_turns_retention_check',
      ]),
    );
    expect(operationConfig.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        'request_claim_id',
        'request_ownership_token_hash',
        'operation_kind',
        'operation_hash',
        'result_hash',
        'stored_result',
      ]),
    );
    expect(
      operationConfig.foreignKeys.map((foreignKey) =>
        getTableName(foreignKey.reference().foreignTable),
      ),
    ).toContain('manager_turns');
  });
});
