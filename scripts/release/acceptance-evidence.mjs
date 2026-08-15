import {
  createHash,
  createPublicKey,
  timingSafeEqual,
  verify,
} from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

export const ACCEPTANCE_EVIDENCE_SCHEMA_VERSION = 1;
export const ACCEPTANCE_EVIDENCE_FILENAME = 'acceptance-evidence.json';
export const ACCEPTANCE_PRODUCER_WORKFLOW = '.github/workflows/staging.yml';
export const ACCEPTANCE_CI_WORKFLOW = '.github/workflows/ci.yml';

export const REQUIRED_CI_JOBS = Object.freeze([
  'application',
  'infrastructure',
  'container-build-api',
  'container-build-worker',
  'container-build-web',
  'browser-production-preview',
  'agent-evals',
  'postgres-integration',
]);

export const REQUIRED_GATES = Object.freeze([
  Object.freeze({
    id: 'http-api-subset',
    evidenceClass: 'staging-http-subset',
  }),
  Object.freeze({
    id: 'production-preview-browser',
    evidenceClass: 'production-preview-browser',
  }),
  Object.freeze({
    id: 'pwa-install-offline-reopen',
    evidenceClass: 'production-preview-browser',
  }),
  Object.freeze({
    id: 'powersync-browser-connect-sync-entities-roundtrip',
    evidenceClass: 'staging-browser-cross-component',
  }),
  Object.freeze({
    id: 'powersync-two-device-private-shared-isolation',
    evidenceClass: 'staging-browser-cross-component',
  }),
  Object.freeze({
    id: 'offline-conflict-resolution',
    evidenceClass: 'staging-cross-component',
  }),
  Object.freeze({
    id: 'voice-ptt-storage-playback',
    evidenceClass: 'production-preview-browser',
  }),
  Object.freeze({
    id: 'service-worker-safe-update',
    evidenceClass: 'production-preview-browser',
  }),
  Object.freeze({
    id: 'web-push-preferences',
    evidenceClass: 'production-preview-browser',
  }),
  Object.freeze({
    id: 'wcag-2.2-aa',
    evidenceClass: 'production-preview-browser',
  }),
  Object.freeze({
    id: 'agent-evals-provider-free',
    evidenceClass: 'ci-agent-eval',
  }),
  Object.freeze({
    id: 'agent-evals-production-runtime',
    evidenceClass: 'ci-agent-eval',
  }),
  Object.freeze({
    id: 'scheduler-domain-workflow',
    evidenceClass: 'staging-cross-component',
  }),
  Object.freeze({
    id: 'finance-domain-workflow',
    evidenceClass: 'staging-cross-component',
  }),
  Object.freeze({
    id: 'shopping-domain-workflow',
    evidenceClass: 'staging-cross-component',
  }),
  Object.freeze({
    id: 'rls-cross-household-attacks',
    evidenceClass: 'staging-database-security',
  }),
  Object.freeze({
    id: 'approval-stale-tampered-replay',
    evidenceClass: 'staging-cross-component',
  }),
  Object.freeze({
    id: 'approval-provider-readback',
    evidenceClass: 'credentialed-live-readback',
  }),
  Object.freeze({
    id: 'fresh-database-migration',
    evidenceClass: 'staging-recovery',
  }),
  Object.freeze({
    id: 'backup-age-and-logical-restore',
    evidenceClass: 'staging-recovery',
  }),
  Object.freeze({
    id: 'backward-compatible-rollback',
    evidenceClass: 'staging-recovery',
  }),
  Object.freeze({
    id: 'powersync-contract-and-stream-isolation',
    evidenceClass: 'staging-cross-component',
  }),
]);

export const REQUIRED_PROVIDER_SMOKES = Object.freeze([
  'openai-agents',
  'openai-transcription',
  'openai-speech',
  'google-oauth',
  'google-calendar-write-readback',
  'google-maps-routes',
  'transactional-email',
  'web-push',
  'commerce-live-offer',
]);

export const ACCEPTANCE_RECEIPT_SCHEMA_VERSION = 1;

const POSITIVE_INTEGER = Symbol('positive-integer');
const NON_EMPTY_IDENTIFIER = Symbol('non-empty-identifier');
const SHA256_PROOF = Symbol('sha256-proof');

const freezeDefinition = (definition) =>
  Object.freeze({
    ...definition,
    proof: Object.freeze({ ...definition.proof }),
  });

const CI_RECEIPT_DEFINITIONS = Object.freeze({
  application: freezeDefinition({
    runner: 'ci',
    proof: {
      formatCheck: 'passed',
      lint: 'passed',
      typecheck: 'passed',
      unitTests: 'passed',
      build: 'passed',
      packageSmoke: 'passed',
    },
  }),
  infrastructure: freezeDefinition({
    runner: 'ci',
    proof: {
      shellcheck: 'passed',
      shellSyntax: 'passed',
      composeRender: 'passed',
      infrastructureTests: 'passed',
    },
  }),
  'container-build-api': freezeDefinition({
    runner: 'ci',
    proof: {
      buildTarget: 'api',
      imageBuild: 'passed',
      platform: 'linux/amd64',
      sourceBuildArgumentBound: true,
    },
  }),
  'container-build-worker': freezeDefinition({
    runner: 'ci',
    proof: {
      buildTarget: 'worker',
      imageBuild: 'passed',
      platform: 'linux/amd64',
      sourceBuildArgumentBound: true,
    },
  }),
  'container-build-web': freezeDefinition({
    runner: 'ci',
    proof: {
      buildTarget: 'web',
      imageBuild: 'passed',
      platform: 'linux/amd64',
      sourceBuildArgumentBound: true,
    },
  }),
  'browser-production-preview': freezeDefinition({
    runner: 'ci',
    proof: {
      productionBuildServed: true,
      chromiumSuite: 'passed',
      browserTestCount: POSITIVE_INTEGER,
    },
  }),
  'agent-evals': freezeDefinition({
    runner: 'ci',
    proof: {
      providerFreeSuite: 'passed',
      productionRuntimeSuite: 'passed',
      forbiddenToolSuite: 'passed',
      approvalInterruptionSuite: 'passed',
      evalCaseCount: POSITIVE_INTEGER,
    },
  }),
  'postgres-integration': freezeDefinition({
    runner: 'ci',
    proof: {
      postgresqlMajor: 17,
      pgvectorExtension: 'passed',
      isolatedDatabases: true,
      sequentialSuites: 'passed',
      suiteCount: 15,
      attackCaseCount: POSITIVE_INTEGER,
    },
  }),
});

const GATE_RECEIPT_DEFINITIONS = Object.freeze({
  'http-api-subset': freezeDefinition({
    runner: 'staging',
    proof: {
      healthz: 'passed',
      syntheticHttpSubsetReadiness: 'passed',
      protectedMetrics: 'passed',
      requestIds: 'passed',
      problemJson: 'passed',
    },
  }),
  'production-preview-browser': freezeDefinition({
    runner: 'ci',
    proof: {
      productionBundle: 'passed',
      directRoutes: 'passed',
      responsiveShell: 'passed',
      browserTestCount: POSITIVE_INTEGER,
    },
  }),
  'pwa-install-offline-reopen': freezeDefinition({
    runner: 'ci',
    proof: {
      install: 'passed',
      offlineEdit: 'passed',
      reopenPersistence: 'passed',
      browserTestCount: POSITIVE_INTEGER,
    },
  }),
  'powersync-browser-connect-sync-entities-roundtrip': freezeDefinition({
    runner: 'staging',
    proof: {
      browserConnectCalled: true,
      canonicalApiWrite: true,
      replicationReadbackMatched: true,
      syncEntityRevisionMatched: true,
    },
  }),
  'powersync-two-device-private-shared-isolation': freezeDefinition({
    runner: 'staging',
    proof: {
      deviceCount: 2,
      privateIsolation: 'passed',
      sharedVisibility: 'passed',
      globalTenantStreamAbsent: true,
    },
  }),
  'offline-conflict-resolution': freezeDefinition({
    runner: 'staging',
    proof: {
      offlineMutation: 'passed',
      conflictSurfaced: true,
      deterministicResolution: 'passed',
      externalWriteTriggered: false,
    },
  }),
  'voice-ptt-storage-playback': freezeDefinition({
    runner: 'ci',
    proof: {
      audioPersisted: false,
      transcriptCorrection: 'passed',
      captions: 'passed',
      playbackControls: 'passed',
      objectUrlRevoked: true,
    },
  }),
  'service-worker-safe-update': freezeDefinition({
    runner: 'ci',
    proof: {
      pendingChangesPreserved: true,
      activationDeferred: true,
      reloadRecovery: 'passed',
    },
  }),
  'web-push-preferences': freezeDefinition({
    runner: 'ci',
    proof: {
      inAppNotifications: 'passed',
      webPushPreferences: 'passed',
      emailPreferences: 'passed',
      sensitivePreviewOmitted: true,
    },
  }),
  'wcag-2.2-aa': freezeDefinition({
    runner: 'ci',
    proof: {
      automatedCriticalViolations: 0,
      keyboardNavigation: 'passed',
      screenReaderLabels: 'passed',
      contrast: 'passed',
    },
  }),
  'agent-evals-provider-free': freezeDefinition({
    runner: 'ci',
    proof: {
      routing: 'passed',
      capabilityDenial: 'passed',
      promptInjection: 'passed',
      partialFailure: 'passed',
      evalCaseCount: POSITIVE_INTEGER,
    },
  }),
  'agent-evals-production-runtime': freezeDefinition({
    runner: 'ci',
    proof: {
      lunaTerraRouting: 'passed',
      approvalInterruption: 'passed',
      usageBudget: 'passed',
      resolvedModelRecorded: true,
      evalCaseCount: POSITIVE_INTEGER,
    },
  }),
  'scheduler-domain-workflow': freezeDefinition({
    runner: 'staging',
    proof: {
      rankedAlternatives: 'passed',
      torontoDst: 'passed',
      travelTime: 'passed',
      visualApprovalRequired: true,
    },
  }),
  'finance-domain-workflow': freezeDefinition({
    runner: 'staging',
    proof: {
      importPreview: 'passed',
      duplicateIsolation: 'passed',
      rejectedRowsIsolated: true,
      arithmeticToCent: 'passed',
      editableCadBudget: 'passed',
    },
  }),
  'shopping-domain-workflow': freezeDefinition({
    runner: 'staging',
    proof: {
      retailerGrouping: 'passed',
      liveOfferFreshness: 'passed',
      substitutions: 'passed',
      unknownCostsDisclosed: true,
      checkoutLinkOnly: true,
    },
  }),
  'rls-cross-household-attacks': freezeDefinition({
    runner: 'staging',
    proof: {
      crossHouseholdReadDenied: true,
      crossHouseholdWriteDenied: true,
      privateOwnerBypassDenied: true,
      signedClaimScope: 'passed',
      attackCaseCount: POSITIVE_INTEGER,
    },
  }),
  'approval-stale-tampered-replay': freezeDefinition({
    runner: 'staging',
    proof: {
      staleDenied: true,
      tamperedDenied: true,
      replayDenied: true,
      typedYesDenied: true,
      voiceDenied: true,
    },
  }),
  'approval-provider-readback': freezeDefinition({
    runner: 'staging',
    requiresWriteReadback: true,
    proof: {
      visualDecisionBound: true,
      providerPreconditionsRevalidated: true,
      idempotency: 'passed',
      readbackMatched: true,
    },
  }),
  'fresh-database-migration': freezeDefinition({
    runner: 'staging',
    proof: {
      emptyDatabaseMigration: 'passed',
      schemaVersionVerified: true,
      seedSyntheticOnly: true,
    },
  }),
  'backup-age-and-logical-restore': freezeDefinition({
    runner: 'staging',
    proof: {
      ageWithinPolicy: true,
      hashVerified: true,
      logicalRestore: 'passed',
      restoredSourceShaMatched: true,
    },
  }),
  'backward-compatible-rollback': freezeDefinition({
    runner: 'staging',
    proof: {
      candidateFailureInjected: true,
      previousDigestRestored: true,
      healthAfterRollback: 'passed',
      migrationReversalUsed: false,
    },
  }),
  'powersync-contract-and-stream-isolation': freezeDefinition({
    runner: 'staging',
    proof: {
      publicationContract: 'passed',
      privateStreamIsolation: 'passed',
      sharedStreamIsolation: 'passed',
      clientTenantClaimIgnored: true,
      tombstoneRoundtrip: 'passed',
    },
  }),
});

const providerDefinition = (proof, requiresWriteReadback = false) =>
  freezeDefinition({
    runner: 'staging',
    provider: true,
    requiresWriteReadback,
    proof: {
      credentialed: true,
      liveRequest: true,
      simulationUsed: false,
      skipped: false,
      credentialSource: 'protected-environment',
      providerRequestIdHash: SHA256_PROOF,
      providerResponseSha256: SHA256_PROOF,
      ...proof,
    },
  });

const PROVIDER_RECEIPT_DEFINITIONS = Object.freeze({
  'openai-agents': providerDefinition({
    managerSpecialistRun: 'passed',
    resolvedModel: NON_EMPTY_IDENTIFIER,
    toolTrace: 'passed',
  }),
  'openai-transcription': providerDefinition({
    audioHandling: 'in-memory',
    transcriptNonempty: true,
    modelAvailability: 'passed',
  }),
  'openai-speech': providerDefinition({
    audioResponse: 'passed',
    noStore: true,
    modelAvailability: 'passed',
  }),
  'google-oauth': providerDefinition({
    pkceVerified: true,
    stateVerified: true,
    incrementalScope: 'passed',
    encryptedTokenVault: 'passed',
  }),
  'google-calendar-write-readback': providerDefinition(
    {
      visualApprovalBound: true,
      exactlyOneEvent: true,
      calendarReadback: 'passed',
    },
    true,
  ),
  'google-maps-routes': providerDefinition({
    routeFreshness: 'passed',
    travelDuration: 'passed',
    fallbackLabeled: true,
  }),
  'transactional-email': providerDefinition(
    {
      sensitivePreviewOmitted: true,
      providerAccepted: true,
      deliveryStatusReadback: 'passed',
    },
    true,
  ),
  'web-push': providerDefinition(
    {
      sensitivePreviewOmitted: true,
      providerAccepted: true,
      deliveryAcknowledged: true,
    },
    true,
  ),
  'commerce-live-offer': providerDefinition({
    offerFreshness: 'passed',
    comparisonPermission: true,
    sourceUrlVerified: true,
    unsupportedValuesUnavailable: true,
  }),
});

const IMAGE_KEYS = Object.freeze([
  'API_IMAGE',
  'WORKER_IMAGE',
  'WEB_IMAGE',
  'POSTGRES_IMAGE',
  'POWERSYNC_IMAGE',
  'CADDY_IMAGE',
]);
const MANIFEST_IMAGE_KEYS = Object.freeze([
  'api',
  'worker',
  'web',
  'postgres',
  'powersync',
  'caddy',
]);
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const SHA_256 = /^[0-9a-f]{64}$/u;
const SOURCE_SHA = /^[0-9a-f]{40}$/u;
const RUN_ID = /^[1-9][0-9]{0,19}$/u;
const IMAGE_REFERENCE = /^[a-z0-9][a-z0-9./:_-]*@sha256:[0-9a-f]{64}$/u;
const SAFE_ARTIFACT_NAME = /^[a-z0-9][a-z0-9._/-]{0,127}$/u;
const MAX_MANIFEST_BYTES = 1_048_576;
const MAX_RECEIPT_BYTES = 1_048_576;
const MAX_EVIDENCE_LIFETIME_MS = 24 * 60 * 60 * 1000;
const MAX_MANIFEST_LIFETIME_MS = 6 * 60 * 60 * 1000;
const MIN_EVIDENCE_LIFETIME_MS = 15 * 60 * 1000;
const NON_EMPTY_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}$/u;

const fail = (message) => {
  throw new Error(`Invalid acceptance evidence: ${message}`);
};

const exactRecord = (value, keys, path) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${path} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(`${path} has an unsafe prototype`);
  }
  const actualKeys = Reflect.ownKeys(value);
  if (
    actualKeys.some((key) => typeof key !== 'string' || FORBIDDEN_KEYS.has(key))
  ) {
    fail(`${path} has a forbidden property`);
  }
  const sortedActual = [...actualKeys].sort();
  const sortedExpected = [...keys].sort();
  if (
    sortedActual.length !== sortedExpected.length ||
    sortedActual.some((key, index) => key !== sortedExpected[index])
  ) {
    fail(`${path} has unexpected or missing fields`);
  }
  for (const key of actualKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !Object.hasOwn(descriptor, 'value') ||
      descriptor.enumerable !== true
    ) {
      fail(`${path}.${key} must be an enumerable data property`);
    }
  }
  return value;
};

const ownValue = (record, key, path) => {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
    fail(`${path}.${key} is not a data property`);
  }
  return descriptor.value;
};

const exactArray = (value, length, path) => {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    fail(`${path} must be an array`);
  }
  if (value.length !== length) fail(`${path} has the wrong number of entries`);
  const keys = Object.keys(value);
  if (
    keys.length !== length ||
    keys.some((key, index) => key !== String(index))
  ) {
    fail(`${path} must be a dense data-only array`);
  }
  return Array.from({ length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
      fail(`${path}[${index}] must be a data property`);
    }
    return descriptor.value;
  });
};

const stringValue = (value, path, pattern) => {
  if (
    typeof value !== 'string' ||
    (pattern !== undefined && !pattern.test(value))
  ) {
    fail(`${path} is invalid`);
  }
  return value;
};

const literal = (value, expected, path) => {
  if (value !== expected) fail(`${path} must be ${JSON.stringify(expected)}`);
  return value;
};

const instant = (value, path) => {
  const text = stringValue(value, path);
  const milliseconds = Date.parse(text);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== text
  ) {
    fail(`${path} must be a canonical UTC instant`);
  }
  return milliseconds;
};

const artifactReceipt = (value, path) => {
  const record = exactRecord(value, ['name', 'sha256'], path);
  const name = stringValue(
    ownValue(record, 'name', path),
    `${path}.name`,
    SAFE_ARTIFACT_NAME,
  );
  if (
    name.startsWith('/') ||
    name.includes('//') ||
    name.split('/').includes('..')
  ) {
    fail(`${path}.name is not a scoped artifact name`);
  }
  if (!name.startsWith('artifacts/')) {
    fail(`${path}.name must be beneath artifacts/`);
  }
  const digest = stringValue(
    ownValue(record, 'sha256', path),
    `${path}.sha256`,
    SHA_256,
  );
  if (/^0{64}$/u.test(digest)) fail(`${path}.sha256 uses a placeholder digest`);
  return Object.freeze({ name, sha256: digest });
};

const validateObservedAt = (value, path, issuedAt) => {
  const observedAt = instant(value, path);
  if (
    observedAt > issuedAt ||
    issuedAt - observedAt > MAX_EVIDENCE_LIFETIME_MS
  ) {
    fail(`${path} is outside the 24-hour evidence window`);
  }
  return observedAt;
};

const receiptContract = (category, id) => {
  let definitions;
  let receiptCategory;
  if (category === 'ci') {
    definitions = CI_RECEIPT_DEFINITIONS;
    receiptCategory = 'ci';
  } else if (category === 'gates') {
    definitions = GATE_RECEIPT_DEFINITIONS;
    receiptCategory = 'gate';
  } else if (category === 'providers') {
    definitions = PROVIDER_RECEIPT_DEFINITIONS;
    receiptCategory = 'provider';
  } else {
    fail('receipt category is invalid');
  }
  const definition = Object.hasOwn(definitions, id)
    ? definitions[id]
    : undefined;
  if (definition === undefined)
    fail(`receipt ID ${JSON.stringify(id)} is invalid`);
  return Object.freeze({ definition, receiptCategory });
};

const validateImageRecord = (value, path, expectedImages) => {
  const record = exactRecord(value, MANIFEST_IMAGE_KEYS, path);
  const images = {};
  for (const key of MANIFEST_IMAGE_KEYS) {
    const reference = stringValue(
      ownValue(record, key, path),
      `${path}.${key}`,
      IMAGE_REFERENCE,
    );
    if (expectedImages !== undefined) {
      literal(reference, expectedImages[key], `${path}.${key}`);
    }
    images[key] = reference;
  }
  return Object.freeze(images);
};

const validateProof = (value, definition, path) => {
  const requirements = definition.proof;
  const proof = exactRecord(value, Object.keys(requirements), path);
  for (const [key, requirement] of Object.entries(requirements)) {
    const proofPath = `${path}.${key}`;
    const actual = ownValue(proof, key, path);
    if (requirement === POSITIVE_INTEGER) {
      if (!Number.isSafeInteger(actual) || actual < 1) {
        fail(`${proofPath} must be a positive integer`);
      }
    } else if (requirement === NON_EMPTY_IDENTIFIER) {
      stringValue(actual, proofPath, NON_EMPTY_IDENTIFIER_PATTERN);
    } else if (requirement === SHA256_PROOF) {
      const digest = stringValue(actual, proofPath, SHA_256);
      if (/^0{64}$/u.test(digest))
        fail(`${proofPath} uses a placeholder digest`);
    } else {
      literal(actual, requirement, proofPath);
    }
  }
  return proof;
};

const validateWriteReadback = (value, path) => {
  const record = exactRecord(
    value,
    [
      'targetHash',
      'writeOperationIdHash',
      'idempotencyKeyHash',
      'expectedPayloadSha256',
      'readbackPayloadSha256',
      'providerVersionHash',
    ],
    path,
  );
  for (const key of [
    'targetHash',
    'writeOperationIdHash',
    'idempotencyKeyHash',
    'expectedPayloadSha256',
    'readbackPayloadSha256',
    'providerVersionHash',
  ]) {
    const digest = stringValue(
      ownValue(record, key, path),
      `${path}.${key}`,
      SHA_256,
    );
    if (/^0{64}$/u.test(digest))
      fail(`${path}.${key} uses a placeholder digest`);
  }
  literal(
    ownValue(record, 'readbackPayloadSha256', path),
    ownValue(record, 'expectedPayloadSha256', path),
    `${path}.readbackPayloadSha256`,
  );
  return record;
};

const validateReceiptExecution = (
  value,
  definition,
  sourceSha,
  path,
  context,
) => {
  const execution = exactRecord(
    value,
    ['workflow', 'runId', 'headSha', 'event', 'conclusion'],
    path,
  );
  const isCi = definition.runner === 'ci';
  literal(
    ownValue(execution, 'workflow', path),
    isCi ? ACCEPTANCE_CI_WORKFLOW : ACCEPTANCE_PRODUCER_WORKFLOW,
    `${path}.workflow`,
  );
  const runId = stringValue(
    ownValue(execution, 'runId', path),
    `${path}.runId`,
    RUN_ID,
  );
  literal(ownValue(execution, 'headSha', path), sourceSha, `${path}.headSha`);
  literal(
    ownValue(execution, 'event', path),
    isCi ? 'push' : 'workflow_dispatch',
    `${path}.event`,
  );
  literal(
    ownValue(execution, 'conclusion', path),
    'success',
    `${path}.conclusion`,
  );
  if (context !== undefined) {
    literal(
      runId,
      isCi ? context.ciRunId : context.producerRunId,
      `${path}.runId`,
    );
    literal(
      sourceSha,
      isCi ? context.ciHeadSha : context.producerHeadSha,
      `${path}.headSha`,
    );
    literal(
      isCi ? context.ciConclusion : context.producerConclusion,
      'success',
      `${path} context conclusion`,
    );
  }
  return execution;
};

export const validateAcceptanceReceipt = (value, expected) => {
  const expectedRecord = exactRecord(
    expected,
    ['category', 'id', 'context'],
    'expectedReceipt',
  );
  const category = stringValue(
    ownValue(expectedRecord, 'category', 'expectedReceipt'),
    'expectedReceipt.category',
  );
  const id = stringValue(
    ownValue(expectedRecord, 'id', 'expectedReceipt'),
    'expectedReceipt.id',
  );
  const context = ownValue(expectedRecord, 'context', 'expectedReceipt');
  if (
    context !== undefined &&
    (context === null || typeof context !== 'object')
  ) {
    fail('expectedReceipt.context must be an object or undefined');
  }
  const { definition, receiptCategory } = receiptContract(category, id);
  const requiresImages = definition.runner === 'staging';
  const rootKeys = [
    'schemaVersion',
    'category',
    'id',
    'sourceSha',
    'environment',
    'observedAt',
    'execution',
    'result',
  ];
  if (requiresImages) rootKeys.push('images');
  if (definition.requiresWriteReadback === true) rootKeys.push('writeReadback');
  const root = exactRecord(value, rootKeys, 'receipt');
  literal(
    ownValue(root, 'schemaVersion', 'receipt'),
    ACCEPTANCE_RECEIPT_SCHEMA_VERSION,
    'receipt.schemaVersion',
  );
  literal(
    ownValue(root, 'category', 'receipt'),
    receiptCategory,
    'receipt.category',
  );
  literal(ownValue(root, 'id', 'receipt'), id, 'receipt.id');
  const sourceSha = stringValue(
    ownValue(root, 'sourceSha', 'receipt'),
    'receipt.sourceSha',
    SOURCE_SHA,
  );
  if (context !== undefined) {
    literal(sourceSha, context.sourceSha, 'receipt.sourceSha');
  }
  const environment = definition.runner === 'ci' ? 'ci' : 'staging';
  literal(
    ownValue(root, 'environment', 'receipt'),
    environment,
    'receipt.environment',
  );
  const observedAtText = stringValue(
    ownValue(root, 'observedAt', 'receipt'),
    'receipt.observedAt',
  );
  const observedAt = instant(observedAtText, 'receipt.observedAt');
  validateReceiptExecution(
    ownValue(root, 'execution', 'receipt'),
    definition,
    sourceSha,
    'receipt.execution',
    context,
  );
  if (requiresImages) {
    validateImageRecord(
      ownValue(root, 'images', 'receipt'),
      'receipt.images',
      context?.images,
    );
  }

  const resultKeys = ['outcome', 'proof'];
  if (category !== 'ci') resultKeys.push('evidenceClass');
  if (category === 'providers') resultKeys.push('releaseEligible');
  const result = exactRecord(
    ownValue(root, 'result', 'receipt'),
    resultKeys,
    'receipt.result',
  );
  literal(
    ownValue(result, 'outcome', 'receipt.result'),
    category === 'ci' ? 'success' : 'passed',
    'receipt.result.outcome',
  );
  let evidenceClass;
  if (category === 'gates') {
    evidenceClass = REQUIRED_GATES.find(
      (candidate) => candidate.id === id,
    )?.evidenceClass;
    literal(
      ownValue(result, 'evidenceClass', 'receipt.result'),
      evidenceClass,
      'receipt.result.evidenceClass',
    );
  } else if (category === 'providers') {
    evidenceClass = 'credentialed-live';
    literal(
      ownValue(result, 'evidenceClass', 'receipt.result'),
      evidenceClass,
      'receipt.result.evidenceClass',
    );
    literal(
      ownValue(result, 'releaseEligible', 'receipt.result'),
      true,
      'receipt.result.releaseEligible',
    );
  }
  validateProof(
    ownValue(result, 'proof', 'receipt.result'),
    definition,
    'receipt.result.proof',
  );
  if (definition.requiresWriteReadback === true) {
    validateWriteReadback(
      ownValue(root, 'writeReadback', 'receipt'),
      'receipt.writeReadback',
    );
  }
  return Object.freeze({
    category,
    id,
    sourceSha,
    environment,
    observedAt,
    observedAtText,
    evidenceClass,
  });
};

export const parseAcceptanceReceipt = (source, expected) => {
  if (
    typeof source !== 'string' ||
    Buffer.byteLength(source, 'utf8') > MAX_RECEIPT_BYTES ||
    source.startsWith('\uFEFF')
  ) {
    fail('receipt encoding or size is invalid');
  }
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    fail('receipt is not valid JSON');
  }
  if (source !== `${canonicalJson(value)}\n`)
    fail('receipt is not canonical JSON');
  const verification = validateAcceptanceReceipt(value, expected);
  return Object.freeze({ value, verification });
};

export const validateAcceptanceDescriptor = (value, expected) => {
  const expectedRecord = exactRecord(
    expected,
    ['category', 'id'],
    'expectedDescriptor',
  );
  const category = stringValue(
    ownValue(expectedRecord, 'category', 'expectedDescriptor'),
    'expectedDescriptor.category',
  );
  const id = stringValue(
    ownValue(expectedRecord, 'id', 'expectedDescriptor'),
    'expectedDescriptor.id',
  );
  receiptContract(category, id);
  const descriptor = exactRecord(value, ['id', 'artifact'], 'descriptor');
  literal(ownValue(descriptor, 'id', 'descriptor'), id, 'descriptor.id');
  const artifact = artifactReceipt(
    ownValue(descriptor, 'artifact', 'descriptor'),
    'descriptor.artifact',
  );
  literal(
    artifact.name,
    `artifacts/${category}/${id}.json`,
    'descriptor.artifact.name',
  );
  return Object.freeze({ id, artifact });
};

export const parseAcceptanceImageLock = (source) => {
  if (typeof source !== 'string' || source.length > 32_768) {
    fail('image lock is invalid');
  }
  const values = new Map();
  for (const line of source.split(/\r?\n/u)) {
    if (line === '' || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) fail('image lock contains a malformed line');
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (values.has(key)) fail(`image lock repeats ${key}`);
    values.set(key, value);
  }
  const sourceSha = values.get('SOURCE_SHA');
  if (sourceSha === undefined || !SOURCE_SHA.test(sourceSha)) {
    fail('image lock SOURCE_SHA is invalid');
  }
  const images = {};
  for (let index = 0; index < IMAGE_KEYS.length; index += 1) {
    const key = IMAGE_KEYS[index];
    const reference = values.get(key);
    if (reference === undefined || !IMAGE_REFERENCE.test(reference)) {
      fail(`image lock ${key} is invalid`);
    }
    images[MANIFEST_IMAGE_KEYS[index]] = reference;
  }
  return Object.freeze({ sourceSha, images: Object.freeze(images) });
};

export const validateAcceptanceEvidence = (value, context) => {
  const root = exactRecord(
    value,
    [
      'schemaVersion',
      'sourceSha',
      'environment',
      'issuedAt',
      'expiresAt',
      'images',
      'producer',
      'ci',
      'gates',
      'providers',
    ],
    'manifest',
  );
  literal(
    ownValue(root, 'schemaVersion', 'manifest'),
    ACCEPTANCE_EVIDENCE_SCHEMA_VERSION,
    'manifest.schemaVersion',
  );
  const sourceSha = stringValue(
    ownValue(root, 'sourceSha', 'manifest'),
    'manifest.sourceSha',
    SOURCE_SHA,
  );
  literal(sourceSha, context.sourceSha, 'manifest.sourceSha');
  const environment = literal(
    ownValue(root, 'environment', 'manifest'),
    'staging',
    'manifest.environment',
  );
  literal(environment, context.environment, 'manifest.environment');

  const issuedAt = instant(
    ownValue(root, 'issuedAt', 'manifest'),
    'manifest.issuedAt',
  );
  const expiresAt = instant(
    ownValue(root, 'expiresAt', 'manifest'),
    'manifest.expiresAt',
  );
  if (
    expiresAt - issuedAt < MIN_EVIDENCE_LIFETIME_MS ||
    expiresAt - issuedAt > MAX_MANIFEST_LIFETIME_MS
  ) {
    fail('manifest lifetime must be between 15 minutes and 6 hours');
  }
  if (context.now < issuedAt || context.now > expiresAt) {
    fail('manifest is not currently valid');
  }

  const imageRecord = exactRecord(
    ownValue(root, 'images', 'manifest'),
    MANIFEST_IMAGE_KEYS,
    'manifest.images',
  );
  for (const key of MANIFEST_IMAGE_KEYS) {
    const reference = stringValue(
      ownValue(imageRecord, key, 'manifest.images'),
      `manifest.images.${key}`,
      IMAGE_REFERENCE,
    );
    literal(reference, context.images[key], `manifest.images.${key}`);
  }

  const producer = exactRecord(
    ownValue(root, 'producer', 'manifest'),
    ['workflow', 'runId', 'headSha', 'conclusion'],
    'manifest.producer',
  );
  literal(
    ownValue(producer, 'workflow', 'manifest.producer'),
    ACCEPTANCE_PRODUCER_WORKFLOW,
    'manifest.producer.workflow',
  );
  literal(
    stringValue(
      ownValue(producer, 'runId', 'manifest.producer'),
      'manifest.producer.runId',
      RUN_ID,
    ),
    context.producerRunId,
    'manifest.producer.runId',
  );
  literal(
    ownValue(producer, 'headSha', 'manifest.producer'),
    context.producerHeadSha,
    'manifest.producer.headSha',
  );
  literal(
    ownValue(producer, 'conclusion', 'manifest.producer'),
    context.producerConclusion,
    'manifest.producer.conclusion',
  );
  literal(context.producerConclusion, 'success', 'producer context conclusion');

  const ci = exactRecord(
    ownValue(root, 'ci', 'manifest'),
    ['workflow', 'runId', 'headSha', 'conclusion', 'jobs'],
    'manifest.ci',
  );
  literal(
    ownValue(ci, 'workflow', 'manifest.ci'),
    ACCEPTANCE_CI_WORKFLOW,
    'manifest.ci.workflow',
  );
  literal(
    stringValue(
      ownValue(ci, 'runId', 'manifest.ci'),
      'manifest.ci.runId',
      RUN_ID,
    ),
    context.ciRunId,
    'manifest.ci.runId',
  );
  literal(
    ownValue(ci, 'headSha', 'manifest.ci'),
    context.ciHeadSha,
    'manifest.ci.headSha',
  );
  literal(sourceSha, context.ciHeadSha, 'same-SHA CI binding');
  literal(
    ownValue(ci, 'conclusion', 'manifest.ci'),
    context.ciConclusion,
    'manifest.ci.conclusion',
  );
  literal(context.ciConclusion, 'success', 'CI context conclusion');
  const jobs = exactArray(
    ownValue(ci, 'jobs', 'manifest.ci'),
    REQUIRED_CI_JOBS.length,
    'manifest.ci.jobs',
  );
  for (let index = 0; index < REQUIRED_CI_JOBS.length; index += 1) {
    const path = `manifest.ci.jobs[${index}]`;
    const job = exactRecord(
      jobs[index],
      ['id', 'conclusion', 'artifact'],
      path,
    );
    literal(ownValue(job, 'id', path), REQUIRED_CI_JOBS[index], `${path}.id`);
    literal(ownValue(job, 'conclusion', path), 'success', `${path}.conclusion`);
    artifactReceipt(ownValue(job, 'artifact', path), `${path}.artifact`);
  }

  const gates = exactArray(
    ownValue(root, 'gates', 'manifest'),
    REQUIRED_GATES.length,
    'manifest.gates',
  );
  for (let index = 0; index < REQUIRED_GATES.length; index += 1) {
    const required = REQUIRED_GATES[index];
    const path = `manifest.gates[${index}]`;
    const gate = exactRecord(
      gates[index],
      ['id', 'status', 'evidenceClass', 'observedAt', 'artifact'],
      path,
    );
    literal(ownValue(gate, 'id', path), required.id, `${path}.id`);
    literal(ownValue(gate, 'status', path), 'passed', `${path}.status`);
    literal(
      ownValue(gate, 'evidenceClass', path),
      required.evidenceClass,
      `${path}.evidenceClass`,
    );
    validateObservedAt(
      ownValue(gate, 'observedAt', path),
      `${path}.observedAt`,
      issuedAt,
    );
    artifactReceipt(ownValue(gate, 'artifact', path), `${path}.artifact`);
  }

  const providers = exactArray(
    ownValue(root, 'providers', 'manifest'),
    REQUIRED_PROVIDER_SMOKES.length,
    'manifest.providers',
  );
  for (let index = 0; index < REQUIRED_PROVIDER_SMOKES.length; index += 1) {
    const path = `manifest.providers[${index}]`;
    const provider = exactRecord(
      providers[index],
      [
        'id',
        'status',
        'evidenceClass',
        'releaseEligible',
        'observedAt',
        'artifact',
      ],
      path,
    );
    literal(
      ownValue(provider, 'id', path),
      REQUIRED_PROVIDER_SMOKES[index],
      `${path}.id`,
    );
    literal(ownValue(provider, 'status', path), 'passed', `${path}.status`);
    literal(
      ownValue(provider, 'evidenceClass', path),
      'credentialed-live',
      `${path}.evidenceClass`,
    );
    literal(
      ownValue(provider, 'releaseEligible', path),
      true,
      `${path}.releaseEligible`,
    );
    validateObservedAt(
      ownValue(provider, 'observedAt', path),
      `${path}.observedAt`,
      issuedAt,
    );
    artifactReceipt(ownValue(provider, 'artifact', path), `${path}.artifact`);
  }

  return Object.freeze({ sourceSha, environment, issuedAt, expiresAt });
};

export const canonicalJson = (value) => {
  if (value === null || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value))
      fail('canonical JSON permits safe integers only');
    return String(value);
  }
  if (Array.isArray(value)) {
    const entries = exactArray(value, value.length, 'canonical array');
    return `[${entries.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const keys = Reflect.ownKeys(value);
    if (
      keys.some((key) => typeof key !== 'string' || FORBIDDEN_KEYS.has(key))
    ) {
      fail('canonical object has a forbidden property');
    }
    const sorted = [...keys].sort();
    return `{${sorted
      .map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (
          descriptor === undefined ||
          !Object.hasOwn(descriptor, 'value') ||
          descriptor.enumerable !== true
        ) {
          fail('canonical object contains an accessor');
        }
        return `${JSON.stringify(key)}:${canonicalJson(descriptor.value)}`;
      })
      .join(',')}}`;
  }
  fail('canonical JSON contains an unsupported value');
};

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export const verifyAcceptanceEvidenceBundle = ({
  manifestText,
  digestText,
  signatureText,
  publicKeyPem,
  context,
}) => {
  if (
    typeof manifestText !== 'string' ||
    Buffer.byteLength(manifestText, 'utf8') > MAX_MANIFEST_BYTES ||
    manifestText.startsWith('\uFEFF')
  ) {
    fail('manifest encoding or size is invalid');
  }
  let value;
  try {
    value = JSON.parse(manifestText);
  } catch {
    fail('manifest is not valid JSON');
  }
  validateAcceptanceEvidence(value, context);
  const expectedCanonical = `${canonicalJson(value)}\n`;
  if (manifestText !== expectedCanonical)
    fail('manifest is not canonical JSON');

  const manifestDigest = sha256(Buffer.from(manifestText, 'utf8'));
  const expectedDigestText = `${manifestDigest}  ${ACCEPTANCE_EVIDENCE_FILENAME}\n`;
  if (digestText !== expectedDigestText)
    fail('manifest digest sidecar does not match');
  const signatureBase64 = signatureText.endsWith('\n')
    ? signatureText.slice(0, -1)
    : signatureText;
  if (!/^[A-Za-z0-9+/]{86}==$/u.test(signatureBase64)) {
    fail('detached signature encoding is invalid');
  }
  const signature = Buffer.from(signatureBase64, 'base64');
  if (
    signature.length !== 64 ||
    signature.toString('base64') !== signatureBase64
  ) {
    fail('detached signature is not canonical Ed25519 data');
  }
  let publicKey;
  try {
    publicKey = createPublicKey(publicKeyPem);
  } catch {
    fail('acceptance evidence public key is invalid');
  }
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    fail('acceptance evidence public key must be Ed25519');
  }
  if (!verify(null, Buffer.from(manifestText, 'utf8'), publicKey, signature)) {
    fail('detached signature verification failed');
  }
  const digestBuffer = Buffer.from(manifestDigest, 'hex');
  const sidecarBuffer = Buffer.from(digestText.slice(0, 64), 'hex');
  if (
    digestBuffer.length !== sidecarBuffer.length ||
    !timingSafeEqual(digestBuffer, sidecarBuffer)
  ) {
    fail('manifest digest comparison failed');
  }
  return Object.freeze({ manifestDigest });
};

export const readStrictRegularFile = async (
  path,
  maximumBytes = MAX_MANIFEST_BYTES,
) => {
  const metadata = await lstat(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > maximumBytes
  ) {
    fail('evidence input must be a bounded regular non-symlink file');
  }
  return readFile(path, 'utf8');
};

const verifyReceiptArtifact = async ({
  canonicalRoot,
  artifactsRoot,
  category,
  id,
  artifact,
  context,
  issuedAt,
}) => {
  const checkedArtifact = artifactReceipt(
    artifact,
    `${category}.${id}.artifact`,
  );
  literal(
    checkedArtifact.name,
    `artifacts/${category}/${id}.json`,
    `${category}.${id}.artifact.name`,
  );
  const candidate = resolve(artifactsRoot, checkedArtifact.name);
  const metadata = await lstat(candidate);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size < 1 ||
    metadata.size > MAX_RECEIPT_BYTES
  ) {
    fail(
      `artifact receipt ${checkedArtifact.name} is not a bounded regular file`,
    );
  }
  const canonicalCandidate = await realpath(candidate);
  if (!canonicalCandidate.startsWith(`${canonicalRoot}${sep}`)) {
    fail(`artifact receipt ${checkedArtifact.name} resolves outside its root`);
  }
  const content = await readFile(canonicalCandidate);
  if (sha256(content) !== checkedArtifact.sha256) {
    fail(`artifact receipt ${checkedArtifact.name} digest does not match`);
  }
  let source;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    fail(`artifact receipt ${checkedArtifact.name} is not valid UTF-8`);
  }
  const parsed = parseAcceptanceReceipt(source, { category, id, context });
  validateObservedAt(
    parsed.verification.observedAtText,
    `artifact receipt ${checkedArtifact.name}.observedAt`,
    issuedAt,
  );
  let manifestEntry;
  if (category === 'ci') {
    manifestEntry = {
      id,
      conclusion: 'success',
      artifact: checkedArtifact,
    };
  } else if (category === 'gates') {
    manifestEntry = {
      id,
      status: 'passed',
      evidenceClass: parsed.verification.evidenceClass,
      observedAt: parsed.verification.observedAtText,
      artifact: checkedArtifact,
    };
  } else {
    manifestEntry = {
      id,
      status: 'passed',
      evidenceClass: 'credentialed-live',
      releaseEligible: true,
      observedAt: parsed.verification.observedAtText,
      artifact: checkedArtifact,
    };
  }
  return Object.freeze({
    manifestEntry: Object.freeze(manifestEntry),
    verification: parsed.verification,
  });
};

export const deriveAcceptanceManifestEntryFromArtifact = async ({
  artifactsRoot,
  category,
  id,
  artifact,
  context,
  issuedAt,
}) => {
  const rootMetadata = await lstat(artifactsRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    fail('artifact receipt root must be a regular directory');
  }
  const canonicalRoot = await realpath(artifactsRoot);
  return verifyReceiptArtifact({
    canonicalRoot,
    artifactsRoot,
    category,
    id,
    artifact,
    context,
    issuedAt,
  });
};

const acceptanceContextFromManifest = (manifest, context) => {
  const root = exactRecord(
    manifest,
    [
      'schemaVersion',
      'sourceSha',
      'environment',
      'issuedAt',
      'expiresAt',
      'images',
      'producer',
      'ci',
      'gates',
      'providers',
    ],
    'manifest',
  );
  const issuedAt = instant(
    ownValue(root, 'issuedAt', 'manifest'),
    'manifest.issuedAt',
  );
  validateAcceptanceEvidence(manifest, context);
  return Object.freeze({ root, issuedAt });
};

export const verifyAcceptanceArtifactReceipts = async (
  manifest,
  artifactsRoot,
  context,
) => {
  const rootMetadata = await lstat(artifactsRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    fail('artifact receipt root must be a regular directory');
  }
  const canonicalRoot = await realpath(artifactsRoot);
  const { root, issuedAt } = acceptanceContextFromManifest(manifest, context);
  const ci = exactRecord(
    ownValue(root, 'ci', 'manifest'),
    ['workflow', 'runId', 'headSha', 'conclusion', 'jobs'],
    'manifest.ci',
  );
  const jobs = exactArray(
    ownValue(ci, 'jobs', 'manifest.ci'),
    REQUIRED_CI_JOBS.length,
    'manifest.ci.jobs',
  );
  const gates = exactArray(
    ownValue(root, 'gates', 'manifest'),
    REQUIRED_GATES.length,
    'manifest.gates',
  );
  const providers = exactArray(
    ownValue(root, 'providers', 'manifest'),
    REQUIRED_PROVIDER_SMOKES.length,
    'manifest.providers',
  );
  const receipts = [
    ...jobs.map((entry, index) => ({
      category: 'ci',
      id: REQUIRED_CI_JOBS[index],
      entry,
    })),
    ...gates.map((entry, index) => ({
      category: 'gates',
      id: REQUIRED_GATES[index].id,
      entry,
    })),
    ...providers.map((entry, index) => ({
      category: 'providers',
      id: REQUIRED_PROVIDER_SMOKES[index],
      entry,
    })),
  ];
  const seen = new Set();
  for (let index = 0; index < receipts.length; index += 1) {
    const binding = receipts[index];
    const entryPath = `manifest.${binding.category}[${index}]`;
    const entry = binding.entry;
    const artifact = artifactReceipt(
      ownValue(entry, 'artifact', entryPath),
      `${entryPath}.artifact`,
    );
    if (seen.has(artifact.name)) fail('artifact receipt names must be unique');
    seen.add(artifact.name);
    const verified = await verifyReceiptArtifact({
      canonicalRoot,
      artifactsRoot,
      category: binding.category,
      id: binding.id,
      artifact,
      context,
      issuedAt,
    });
    const derived = verified.manifestEntry;
    for (const key of Object.keys(derived)) {
      if (key === 'artifact') continue;
      literal(
        ownValue(entry, key, entryPath),
        ownValue(derived, key, 'derivedReceipt'),
        `${entryPath}.${key}`,
      );
    }
  }
  return Object.freeze({ artifactCount: seen.size });
};
