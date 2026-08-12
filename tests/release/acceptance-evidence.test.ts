import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ACCEPTANCE_CI_WORKFLOW,
  ACCEPTANCE_EVIDENCE_FILENAME,
  ACCEPTANCE_EVIDENCE_SCHEMA_VERSION,
  ACCEPTANCE_PRODUCER_WORKFLOW,
  REQUIRED_CI_JOBS,
  REQUIRED_GATES,
  REQUIRED_PROVIDER_SMOKES,
  canonicalJson,
  parseAcceptanceReceipt,
  validateAcceptanceDescriptor,
  validateAcceptanceEvidence,
  validateAcceptanceReceipt,
  verifyAcceptanceArtifactReceipts,
  verifyAcceptanceEvidenceBundle,
} from '../../scripts/release/acceptance-evidence.mjs';
import { runAcceptanceEvidenceAssembly } from '../../scripts/release/assemble-acceptance-evidence.mjs';
import { runAcceptanceDescriptorWrite } from '../../scripts/release/write-acceptance-descriptor.mjs';

const sourceSha = 'a'.repeat(40);
const producerRunId = '9001';
const ciRunId = '9000';
const issuedAt = '2026-08-10T04:00:00.000Z';
const observedAt = '2026-08-10T03:55:00.000Z';
const expiresAt = '2026-08-10T05:00:00.000Z';
const digestFor = (value: string | Buffer): string =>
  createHash('sha256').update(value).digest('hex');
const image = (name: string): string =>
  `ghcr.io/panic80/${name}@sha256:${digestFor(name)}`;
const images = Object.freeze({
  api: image('emdo-api'),
  worker: image('emdo-worker'),
  web: image('emdo-web'),
  postgres: image('emdo-postgres'),
  powersync: image('emdo-powersync'),
  caddy: image('emdo-caddy'),
});

const ciProofs: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  application: {
    formatCheck: 'passed',
    lint: 'passed',
    typecheck: 'passed',
    unitTests: 'passed',
    build: 'passed',
    packageSmoke: 'passed',
  },
  infrastructure: {
    shellcheck: 'passed',
    shellSyntax: 'passed',
    composeRender: 'passed',
    infrastructureTests: 'passed',
  },
  'container-build-api': {
    buildTarget: 'api',
    imageBuild: 'passed',
    platform: 'linux/amd64',
    sourceBuildArgumentBound: true,
  },
  'container-build-worker': {
    buildTarget: 'worker',
    imageBuild: 'passed',
    platform: 'linux/amd64',
    sourceBuildArgumentBound: true,
  },
  'container-build-web': {
    buildTarget: 'web',
    imageBuild: 'passed',
    platform: 'linux/amd64',
    sourceBuildArgumentBound: true,
  },
  'browser-production-preview': {
    productionBuildServed: true,
    chromiumSuite: 'passed',
    browserTestCount: 12,
  },
  'agent-evals': {
    providerFreeSuite: 'passed',
    productionRuntimeSuite: 'passed',
    forbiddenToolSuite: 'passed',
    approvalInterruptionSuite: 'passed',
    evalCaseCount: 24,
  },
  'postgres-integration': {
    postgresqlMajor: 17,
    pgvectorExtension: 'passed',
    isolatedDatabases: true,
    sequentialSuites: 'passed',
    suiteCount: 8,
    attackCaseCount: 15,
  },
};

const gateProofs: Readonly<Record<string, Readonly<Record<string, unknown>>>> =
  {
    'http-api-subset': {
      healthz: 'passed',
      readyz: 'passed',
      protectedMetrics: 'passed',
      requestIds: 'passed',
      problemJson: 'passed',
    },
    'production-preview-browser': {
      productionBundle: 'passed',
      directRoutes: 'passed',
      responsiveShell: 'passed',
      browserTestCount: 12,
    },
    'pwa-install-offline-reopen': {
      install: 'passed',
      offlineEdit: 'passed',
      reopenPersistence: 'passed',
      browserTestCount: 4,
    },
    'powersync-browser-connect-sync-entities-roundtrip': {
      browserConnectCalled: true,
      canonicalApiWrite: true,
      replicationReadbackMatched: true,
      syncEntityRevisionMatched: true,
    },
    'powersync-two-device-private-shared-isolation': {
      deviceCount: 2,
      privateIsolation: 'passed',
      sharedVisibility: 'passed',
      globalTenantStreamAbsent: true,
    },
    'offline-conflict-resolution': {
      offlineMutation: 'passed',
      conflictSurfaced: true,
      deterministicResolution: 'passed',
      externalWriteTriggered: false,
    },
    'voice-ptt-storage-playback': {
      audioPersisted: false,
      transcriptCorrection: 'passed',
      captions: 'passed',
      playbackControls: 'passed',
      objectUrlRevoked: true,
    },
    'service-worker-safe-update': {
      pendingChangesPreserved: true,
      activationDeferred: true,
      reloadRecovery: 'passed',
    },
    'web-push-preferences': {
      inAppNotifications: 'passed',
      webPushPreferences: 'passed',
      emailPreferences: 'passed',
      sensitivePreviewOmitted: true,
    },
    'wcag-2.2-aa': {
      automatedCriticalViolations: 0,
      keyboardNavigation: 'passed',
      screenReaderLabels: 'passed',
      contrast: 'passed',
    },
    'agent-evals-provider-free': {
      routing: 'passed',
      capabilityDenial: 'passed',
      promptInjection: 'passed',
      partialFailure: 'passed',
      evalCaseCount: 18,
    },
    'agent-evals-production-runtime': {
      lunaTerraRouting: 'passed',
      approvalInterruption: 'passed',
      usageBudget: 'passed',
      resolvedModelRecorded: true,
      evalCaseCount: 8,
    },
    'scheduler-domain-workflow': {
      rankedAlternatives: 'passed',
      torontoDst: 'passed',
      travelTime: 'passed',
      visualApprovalRequired: true,
    },
    'finance-domain-workflow': {
      importPreview: 'passed',
      duplicateIsolation: 'passed',
      rejectedRowsIsolated: true,
      arithmeticToCent: 'passed',
      editableCadBudget: 'passed',
    },
    'shopping-domain-workflow': {
      retailerGrouping: 'passed',
      liveOfferFreshness: 'passed',
      substitutions: 'passed',
      unknownCostsDisclosed: true,
      checkoutLinkOnly: true,
    },
    'rls-cross-household-attacks': {
      crossHouseholdReadDenied: true,
      crossHouseholdWriteDenied: true,
      privateOwnerBypassDenied: true,
      signedClaimScope: 'passed',
      attackCaseCount: 15,
    },
    'approval-stale-tampered-replay': {
      staleDenied: true,
      tamperedDenied: true,
      replayDenied: true,
      typedYesDenied: true,
      voiceDenied: true,
    },
    'approval-provider-readback': {
      visualDecisionBound: true,
      providerPreconditionsRevalidated: true,
      idempotency: 'passed',
      readbackMatched: true,
    },
    'fresh-database-migration': {
      emptyDatabaseMigration: 'passed',
      schemaVersionVerified: true,
      seedSyntheticOnly: true,
    },
    'backup-age-and-logical-restore': {
      ageWithinPolicy: true,
      hashVerified: true,
      logicalRestore: 'passed',
      restoredSourceShaMatched: true,
    },
    'backward-compatible-rollback': {
      candidateFailureInjected: true,
      previousDigestRestored: true,
      healthAfterRollback: 'passed',
      migrationReversalUsed: false,
    },
    'powersync-contract-and-stream-isolation': {
      publicationContract: 'passed',
      privateStreamIsolation: 'passed',
      sharedStreamIsolation: 'passed',
      clientTenantClaimIgnored: true,
      tombstoneRoundtrip: 'passed',
    },
  };

const providerProofs: Readonly<
  Record<string, Readonly<Record<string, unknown>>>
> = {
  'openai-agents': {
    managerSpecialistRun: 'passed',
    resolvedModel: 'gpt-5.6-luna',
    toolTrace: 'passed',
  },
  'openai-transcription': {
    audioHandling: 'in-memory',
    transcriptNonempty: true,
    modelAvailability: 'passed',
  },
  'openai-speech': {
    audioResponse: 'passed',
    noStore: true,
    modelAvailability: 'passed',
  },
  'google-oauth': {
    pkceVerified: true,
    stateVerified: true,
    incrementalScope: 'passed',
    encryptedTokenVault: 'passed',
  },
  'google-calendar-write-readback': {
    visualApprovalBound: true,
    exactlyOneEvent: true,
    calendarReadback: 'passed',
  },
  'google-maps-routes': {
    routeFreshness: 'passed',
    travelDuration: 'passed',
    fallbackLabeled: true,
  },
  'transactional-email': {
    sensitivePreviewOmitted: true,
    providerAccepted: true,
    deliveryStatusReadback: 'passed',
  },
  'web-push': {
    sensitivePreviewOmitted: true,
    providerAccepted: true,
    deliveryAcknowledged: true,
  },
  'commerce-live-offer': {
    offerFreshness: 'passed',
    comparisonPermission: true,
    sourceUrlVerified: true,
    unsupportedValuesUnavailable: true,
  },
};

const ciGateIds = new Set([
  'production-preview-browser',
  'pwa-install-offline-reopen',
  'voice-ptt-storage-playback',
  'service-worker-safe-update',
  'web-push-preferences',
  'wcag-2.2-aa',
  'agent-evals-provider-free',
  'agent-evals-production-runtime',
]);
const writeReadbackIds = new Set([
  'approval-provider-readback',
  'google-calendar-write-readback',
  'transactional-email',
  'web-push',
]);

const writeReadback = () => ({
  targetHash: digestFor('target'),
  writeOperationIdHash: digestFor('operation-9001'),
  idempotencyKeyHash: digestFor('idempotency-key'),
  expectedPayloadSha256: digestFor('canonical-provider-payload'),
  readbackPayloadSha256: digestFor('canonical-provider-payload'),
  providerVersionHash: digestFor('provider-version-42'),
});

const semanticReceipt = (
  category: 'ci' | 'gates' | 'providers',
  id: string,
) => {
  const runner = category === 'ci' || ciGateIds.has(id) ? 'ci' : 'staging';
  const base: Record<string, unknown> = {
    schemaVersion: 1,
    category:
      category === 'ci' ? 'ci' : category === 'gates' ? 'gate' : 'provider',
    id,
    sourceSha,
    environment: runner,
    observedAt,
    execution: {
      workflow:
        runner === 'ci' ? ACCEPTANCE_CI_WORKFLOW : ACCEPTANCE_PRODUCER_WORKFLOW,
      runId: runner === 'ci' ? ciRunId : producerRunId,
      headSha: sourceSha,
      event: runner === 'ci' ? 'push' : 'workflow_dispatch',
      conclusion: 'success',
    },
  };
  if (runner === 'staging') base.images = { ...images };
  if (category === 'ci') {
    base.result = { outcome: 'success', proof: { ...ciProofs[id] } };
  } else if (category === 'gates') {
    const evidenceClass = REQUIRED_GATES.find(
      (candidate) => candidate.id === id,
    )!.evidenceClass;
    base.result = {
      outcome: 'passed',
      evidenceClass,
      proof: { ...gateProofs[id] },
    };
  } else {
    base.result = {
      outcome: 'passed',
      evidenceClass: 'credentialed-live',
      releaseEligible: true,
      proof: {
        credentialed: true,
        liveRequest: true,
        simulationUsed: false,
        skipped: false,
        credentialSource: 'protected-environment',
        providerRequestIdHash: digestFor(`request-${id}`),
        providerResponseSha256: digestFor(`response-${id}`),
        ...providerProofs[id],
      },
    };
  }
  if (writeReadbackIds.has(id)) base.writeReadback = writeReadback();
  return base;
};

const receipt = (name: string) => ({ name, sha256: digestFor(name) });

const validManifest = () => ({
  schemaVersion: ACCEPTANCE_EVIDENCE_SCHEMA_VERSION,
  sourceSha,
  environment: 'staging',
  issuedAt,
  expiresAt,
  images: { ...images },
  producer: {
    workflow: ACCEPTANCE_PRODUCER_WORKFLOW,
    runId: producerRunId,
    headSha: sourceSha,
    conclusion: 'success',
  },
  ci: {
    workflow: ACCEPTANCE_CI_WORKFLOW,
    runId: ciRunId,
    headSha: sourceSha,
    conclusion: 'success',
    jobs: REQUIRED_CI_JOBS.map((id) => ({
      id,
      conclusion: 'success',
      artifact: receipt(`artifacts/ci/${id}.json`),
    })),
  },
  gates: REQUIRED_GATES.map(({ id, evidenceClass }) => ({
    id,
    status: 'passed',
    evidenceClass,
    observedAt,
    artifact: receipt(`artifacts/gates/${id}.json`),
  })),
  providers: REQUIRED_PROVIDER_SMOKES.map((id) => ({
    id,
    status: 'passed',
    evidenceClass: 'credentialed-live',
    releaseEligible: true,
    observedAt,
    artifact: receipt(`artifacts/providers/${id}.json`),
  })),
});
type AcceptanceEvidenceFixture = ReturnType<typeof validManifest>;

const writeSemanticReceiptSet = async (
  root: string,
  manifest: AcceptanceEvidenceFixture,
): Promise<void> => {
  const bindings = [
    ...manifest.ci.jobs.map((entry) => ({ category: 'ci' as const, entry })),
    ...manifest.gates.map((entry) => ({ category: 'gates' as const, entry })),
    ...manifest.providers.map((entry) => ({
      category: 'providers' as const,
      entry,
    })),
  ];
  for (const { category, entry } of bindings) {
    const source = `${canonicalJson(semanticReceipt(category, entry.id))}\n`;
    entry.artifact.sha256 = digestFor(source);
    const path = join(root, entry.artifact.name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, source);
  }
};

const context = (now = Date.parse('2026-08-10T04:15:00.000Z')) => ({
  sourceSha,
  images,
  environment: 'staging',
  producerRunId,
  producerHeadSha: sourceSha,
  producerConclusion: 'success',
  ciRunId,
  ciHeadSha: sourceSha,
  ciConclusion: 'success',
  now,
});

const signedBundle = (
  manifest: AcceptanceEvidenceFixture,
  privateKey: KeyObject,
) => {
  const manifestText = `${canonicalJson(manifest)}\n`;
  const digest = digestFor(manifestText);
  return {
    manifestText,
    digestText: `${digest}  ${ACCEPTANCE_EVIDENCE_FILENAME}\n`,
    signatureText: `${sign(
      null,
      Buffer.from(manifestText, 'utf8'),
      privateKey,
    ).toString('base64')}\n`,
  };
};

const imageLockSource = (): string =>
  [
    `SOURCE_SHA=${sourceSha}`,
    `API_IMAGE=${images.api}`,
    `WORKER_IMAGE=${images.worker}`,
    `WEB_IMAGE=${images.web}`,
    `POSTGRES_IMAGE=${images.postgres}`,
    `POWERSYNC_IMAGE=${images.powersync}`,
    `CADDY_IMAGE=${images.caddy}`,
    '',
  ].join('\n');

describe('release acceptance evidence', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey
    .export({ type: 'spki', format: 'pem' })
    .toString();

  it('accepts only the complete canonical exact-SHA signed contract', () => {
    const bundle = signedBundle(validManifest(), privateKey);

    expect(
      verifyAcceptanceEvidenceBundle({
        ...bundle,
        publicKeyPem,
        context: context(),
      }),
    ).toEqual({ manifestDigest: digestFor(bundle.manifestText) });
  });

  const invalidMutations: ReadonlyArray<
    readonly [string, (manifest: AcceptanceEvidenceFixture) => void]
  > = [
    [
      'missing gate',
      (manifest) => {
        manifest.gates.pop();
      },
    ],
    [
      'simulated provider',
      (manifest) => {
        manifest.providers[0].evidenceClass = 'recorded-or-simulated';
        manifest.providers[0].releaseEligible = false;
      },
    ],
    [
      'skipped domain workflow',
      (manifest) => {
        manifest.gates.find(
          ({ id }) => id === 'finance-domain-workflow',
        )!.status = 'skipped';
      },
    ],
    [
      'different app digest',
      (manifest) => {
        manifest.images.api = image('different-api');
      },
    ],
    [
      'wrong CI source',
      (manifest) => {
        manifest.ci.headSha = 'b'.repeat(40);
      },
    ],
  ];

  it.each(invalidMutations)('rejects %s evidence', (_label, mutate) => {
    const manifest = validManifest();
    mutate(manifest);

    expect(() => validateAcceptanceEvidence(manifest, context())).toThrow(
      'Invalid acceptance evidence',
    );
  });

  it('rejects an expired but otherwise complete manifest', () => {
    expect(() =>
      validateAcceptanceEvidence(
        validManifest(),
        context(Date.parse('2026-08-10T05:00:00.001Z')),
      ),
    ).toThrow('manifest is not currently valid');
  });

  it('rejects a signed manifest whose lifetime exceeds six hours by one millisecond', () => {
    const manifest = validManifest();
    manifest.expiresAt = new Date(
      Date.parse(manifest.issuedAt) + 6 * 60 * 60 * 1000 + 1,
    ).toISOString();
    const bundle = signedBundle(manifest, privateKey);

    expect(() =>
      verifyAcceptanceEvidenceBundle({
        ...bundle,
        publicKeyPem,
        context: context(Date.parse(manifest.issuedAt)),
      }),
    ).toThrow('manifest lifetime must be between 15 minutes and 6 hours');
  });

  it('rejects noncanonical JSON even when its digest and signature match', () => {
    const manifest = validManifest();
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    const digest = digestFor(manifestText);

    expect(() =>
      verifyAcceptanceEvidenceBundle({
        manifestText,
        digestText: `${digest}  ${ACCEPTANCE_EVIDENCE_FILENAME}\n`,
        signatureText: `${sign(
          null,
          Buffer.from(manifestText, 'utf8'),
          privateKey,
        ).toString('base64')}\n`,
        publicKeyPem,
        context: context(),
      }),
    ).toThrow('manifest is not canonical JSON');
  });

  it('rejects post-signature receipt tampering', () => {
    const manifest = validManifest();
    const signed = signedBundle(manifest, privateKey);
    manifest.gates[0].artifact.sha256 = digestFor('tampered');
    const tamperedText = `${canonicalJson(manifest)}\n`;

    expect(() =>
      verifyAcceptanceEvidenceBundle({
        manifestText: tamperedText,
        digestText: `${digestFor(tamperedText)}  ${ACCEPTANCE_EVIDENCE_FILENAME}\n`,
        signatureText: signed.signatureText,
        publicKeyPem,
        context: context(),
      }),
    ).toThrow('detached signature verification failed');
  });

  it('rejects accessors without invoking them', () => {
    const manifest = validManifest();
    let getterCalls = 0;
    Object.defineProperty(manifest, 'sourceSha', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return sourceSha;
      },
    });

    expect(() => validateAcceptanceEvidence(manifest, context())).toThrow(
      'must be an enumerable data property',
    );
    expect(getterCalls).toBe(0);
  });

  it('requires every unique in-root receipt file to match its signed digest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'emdo-acceptance-receipts-'));
    try {
      const manifest = validManifest();
      const receipts = [
        ...manifest.ci.jobs.map(({ artifact }) => artifact),
        ...manifest.gates.map(({ artifact }) => artifact),
        ...manifest.providers.map(({ artifact }) => artifact),
      ];
      await writeSemanticReceiptSet(root, manifest);

      await expect(
        verifyAcceptanceArtifactReceipts(manifest, root, context()),
      ).resolves.toEqual({ artifactCount: receipts.length });

      await writeFile(join(root, receipts[0].name), 'tampered');
      await expect(
        verifyAcceptanceArtifactReceipts(manifest, root, context()),
      ).rejects.toThrow('digest does not match');
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('rejects a labels-only artifact even when its signed digest matches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'emdo-acceptance-labels-only-'));
    try {
      const manifest = validManifest();
      await writeSemanticReceiptSet(root, manifest);
      const labelsOnly = `${canonicalJson({ status: 'passed' })}\n`;
      const target = manifest.gates[0].artifact;
      target.sha256 = digestFor(labelsOnly);
      await writeFile(join(root, target.name), labelsOnly);

      await expect(
        verifyAcceptanceArtifactReceipts(manifest, root, context()),
      ).rejects.toThrow('receipt');
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it.each([
    ...REQUIRED_CI_JOBS.map((id) => ['ci', id] as const),
    ...REQUIRED_GATES.map(({ id }) => ['gates', id] as const),
    ...REQUIRED_PROVIDER_SMOKES.map((id) => ['providers', id] as const),
  ])('validates the strict semantic receipt for %s/%s', (category, id) => {
    expect(
      validateAcceptanceReceipt(semanticReceipt(category, id), {
        category,
        id,
        context: context(),
      }),
    ).toMatchObject({ category, id, sourceSha });
  });

  it('binds every receipt to the exact source, workflow run, and staging images', () => {
    const wrongSource = semanticReceipt('ci', 'application');
    wrongSource.sourceSha = 'b'.repeat(40);
    expect(() =>
      validateAcceptanceReceipt(wrongSource, {
        category: 'ci',
        id: 'application',
        context: context(),
      }),
    ).toThrow('receipt.sourceSha');

    const wrongRun = semanticReceipt('gates', 'http-api-subset');
    (wrongRun.execution as Record<string, unknown>).runId = '9002';
    expect(() =>
      validateAcceptanceReceipt(wrongRun, {
        category: 'gates',
        id: 'http-api-subset',
        context: context(),
      }),
    ).toThrow('receipt.execution.runId');

    const wrongImages = semanticReceipt('providers', 'openai-agents');
    (wrongImages.images as Record<string, unknown>).api = image('other-api');
    expect(() =>
      validateAcceptanceReceipt(wrongImages, {
        category: 'providers',
        id: 'openai-agents',
        context: context(),
      }),
    ).toThrow('receipt.images.api');
  });

  it('rejects simulated, skipped, or credentialless provider receipts', () => {
    for (const [field, value] of [
      ['simulationUsed', true],
      ['skipped', true],
      ['credentialed', false],
      ['liveRequest', false],
    ] as const) {
      const provider = semanticReceipt('providers', 'openai-agents');
      const result = provider.result as Record<string, unknown>;
      const proof = result.proof as Record<string, unknown>;
      proof[field] = value;
      expect(() =>
        validateAcceptanceReceipt(provider, {
          category: 'providers',
          id: 'openai-agents',
          context: context(),
        }),
      ).toThrow(`receipt.result.proof.${field}`);
    }

    const placeholderResponse = semanticReceipt('providers', 'openai-agents');
    const placeholderResult = placeholderResponse.result as Record<
      string,
      unknown
    >;
    (
      placeholderResult.proof as Record<string, unknown>
    ).providerResponseSha256 = '0'.repeat(64);
    expect(() =>
      validateAcceptanceReceipt(placeholderResponse, {
        category: 'providers',
        id: 'openai-agents',
        context: context(),
      }),
    ).toThrow('placeholder digest');
  });

  it.each([...writeReadbackIds])(
    'requires matching non-placeholder write/readback proof for %s',
    (id) => {
      const category: 'gates' | 'providers' =
        id === 'approval-provider-readback' ? 'gates' : 'providers';
      const missing = semanticReceipt(category, id);
      delete missing.writeReadback;
      expect(() =>
        validateAcceptanceReceipt(missing, {
          category,
          id,
          context: context(),
        }),
      ).toThrow('unexpected or missing fields');

      const mismatched = semanticReceipt(category, id);
      const readback = mismatched.writeReadback as Record<string, unknown>;
      readback.readbackPayloadSha256 = digestFor('different-readback');
      expect(() =>
        validateAcceptanceReceipt(mismatched, {
          category,
          id,
          context: context(),
        }),
      ).toThrow('receipt.writeReadback.readbackPayloadSha256');

      const placeholder = semanticReceipt(category, id);
      (placeholder.writeReadback as Record<string, unknown>).targetHash =
        '0'.repeat(64);
      expect(() =>
        validateAcceptanceReceipt(placeholder, {
          category,
          id,
          context: context(),
        }),
      ).toThrow('placeholder digest');
    },
  );

  it('rejects an ID-swapped proof and generic extra success labels', () => {
    const swapped = semanticReceipt('gates', 'finance-domain-workflow');
    const swappedResult = swapped.result as Record<string, unknown>;
    swappedResult.proof = { ...gateProofs['shopping-domain-workflow'] };
    expect(() =>
      validateAcceptanceReceipt(swapped, {
        category: 'gates',
        id: 'finance-domain-workflow',
        context: context(),
      }),
    ).toThrow('unexpected or missing fields');

    const extraLabel = semanticReceipt('ci', 'application');
    const result = extraLabel.result as Record<string, unknown>;
    (result.proof as Record<string, unknown>).success = true;
    expect(() =>
      validateAcceptanceReceipt(extraLabel, {
        category: 'ci',
        id: 'application',
        context: context(),
      }),
    ).toThrow('unexpected or missing fields');
  });

  it('rejects malformed and noncanonical semantic receipt JSON', () => {
    expect(() =>
      parseAcceptanceReceipt('{', {
        category: 'ci',
        id: 'application',
        context: context(),
      }),
    ).toThrow('receipt is not valid JSON');

    expect(() =>
      parseAcceptanceReceipt(
        JSON.stringify(semanticReceipt('ci', 'application')),
        {
          category: 'ci',
          id: 'application',
          context: context(),
        },
      ),
    ).toThrow('receipt is not canonical JSON');
  });

  it('rejects unsafe receipt prototypes and accessors without invoking them', () => {
    const unsafePrototype = semanticReceipt('ci', 'application');
    Object.setPrototypeOf(unsafePrototype, { inheritedSuccess: true });
    expect(() =>
      validateAcceptanceReceipt(unsafePrototype, {
        category: 'ci',
        id: 'application',
        context: context(),
      }),
    ).toThrow('unsafe prototype');

    const accessor = semanticReceipt('ci', 'application');
    const result = accessor.result as Record<string, unknown>;
    const proof = result.proof as Record<string, unknown>;
    let getterCalls = 0;
    Object.defineProperty(proof, 'build', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'passed';
      },
    });
    expect(() =>
      validateAcceptanceReceipt(accessor, {
        category: 'ci',
        id: 'application',
        context: context(),
      }),
    ).toThrow('must be an enumerable data property');
    expect(getterCalls).toBe(0);
  });

  it('rejects descriptors that try to assert success instead of referencing a receipt', () => {
    expect(() =>
      validateAcceptanceDescriptor(
        {
          id: 'application',
          conclusion: 'success',
          artifact: receipt('artifacts/ci/application.json'),
        },
        { category: 'ci', id: 'application' },
      ),
    ).toThrow('descriptor has unexpected or missing fields');
  });

  it('writes an artifact-only descriptor after validating receipt semantics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'emdo-acceptance-descriptor-'));
    try {
      const source = `${canonicalJson(semanticReceipt('ci', 'application'))}\n`;
      const artifactName = 'artifacts/ci/application.json';
      await mkdir(dirname(join(root, artifactName)), { recursive: true });
      await writeFile(join(root, artifactName), source);

      await runAcceptanceDescriptorWrite([
        '--category',
        'ci',
        '--id',
        'application',
        '--receipts-root',
        root,
        '--artifact-name',
        artifactName,
        '--observed-at',
        observedAt,
      ]);

      const descriptor = JSON.parse(
        await readFile(join(root, 'descriptors/ci/application.json'), 'utf8'),
      ) as Record<string, unknown>;
      expect(Object.keys(descriptor).sort()).toEqual(['artifact', 'id']);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('assembles signed-manifest claims from receipt outcomes, not descriptor labels', async () => {
    const root = await mkdtemp(join(tmpdir(), 'emdo-acceptance-assembly-'));
    try {
      const manifestFixture = validManifest();
      await writeSemanticReceiptSet(root, manifestFixture);
      const bindings = [
        ...manifestFixture.ci.jobs.map(({ id, artifact }) => ({
          category: 'ci',
          id,
          artifact,
        })),
        ...manifestFixture.gates.map(({ id, artifact }) => ({
          category: 'gates',
          id,
          artifact,
        })),
        ...manifestFixture.providers.map(({ id, artifact }) => ({
          category: 'providers',
          id,
          artifact,
        })),
      ];
      for (const { category, id, artifact } of bindings) {
        await runAcceptanceDescriptorWrite([
          '--category',
          category,
          '--id',
          id,
          '--receipts-root',
          root,
          '--artifact-name',
          artifact.name,
          '--observed-at',
          observedAt,
        ]);
      }
      const imageLock = join(root, 'release-images.env');
      const output = join(root, 'acceptance-evidence.json');
      await writeFile(imageLock, imageLockSource());

      await expect(
        runAcceptanceEvidenceAssembly(
          [
            '--receipts-root',
            root,
            '--image-lock',
            imageLock,
            '--producer-run-id',
            producerRunId,
            '--producer-head-sha',
            sourceSha,
            '--producer-conclusion',
            'success',
            '--ci-run-id',
            ciRunId,
            '--ci-head-sha',
            sourceSha,
            '--ci-conclusion',
            'success',
            '--output',
            output,
          ],
          Date.parse(issuedAt),
        ),
      ).resolves.toEqual({
        gateCount: REQUIRED_GATES.length,
        providerCount: REQUIRED_PROVIDER_SMOKES.length,
      });

      const assembled = JSON.parse(await readFile(output, 'utf8')) as {
        ci: { jobs: Array<{ conclusion: string }> };
        gates: Array<{ status: string }>;
        providers: Array<{ releaseEligible: boolean }>;
      };
      expect(
        assembled.ci.jobs.every(({ conclusion }) => conclusion === 'success'),
      ).toBe(true);
      expect(assembled.gates.every(({ status }) => status === 'passed')).toBe(
        true,
      );
      expect(
        assembled.providers.every(({ releaseEligible }) => releaseEligible),
      ).toBe(true);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
