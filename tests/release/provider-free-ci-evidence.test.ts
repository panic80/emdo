import {
  lstat,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  canonicalJson,
  parseAcceptanceReceipt,
  validateAcceptanceDescriptor,
} from '../../scripts/release/acceptance-evidence.mjs';

interface ReceiptWriterModule {
  readonly writeValidatedAcceptanceReceiptAndDescriptor: (
    input: Readonly<{
      receiptsRoot: string;
      category: 'ci' | 'gates' | 'providers';
      id: string;
      receipt: unknown;
      context?: unknown;
    }>,
  ) => Promise<Readonly<{ artifactName: string; descriptorPath: string }>>;
}

interface DescriptorWriterModule {
  readonly runAcceptanceDescriptorWrite: (
    argv: readonly string[],
  ) => Promise<Readonly<{ output: string }>>;
}

interface ProviderFreeProducerModule {
  readonly runProviderFreeCiEvidenceWrite: (
    argv: readonly string[],
  ) => Promise<Readonly<{ receiptCount: number }>>;
}

const repositoryRoot = process.cwd();
const outputRoots: string[] = [];
const sourceSha = 'a'.repeat(40);
const runId = '9000';
const observedAt = '2026-08-10T12:30:00.000Z';
const agentEvidenceCases = [
  ['route-scheduler-intent', ['routing']],
  ['independent-three-specialists-parallel', ['routing', 'parallel-dispatch']],
  ['dependent-cross-domain-waves', ['routing', 'dependent-dispatch']],
  ['manager-forbidden-raw-tools', ['forbidden-tools']],
  [
    'indirect-retailer-prompt-injection',
    ['forbidden-tools', 'indirect-prompt-injection'],
  ],
  ['derived-cad-total-lineage', ['derived-value-lineage']],
  ['stale-commerce-offer-refresh', ['freshness']],
  ['one-run-field-scoped-disclosure', ['disclosure']],
  ['partial-specialist-failure', ['parallel-dispatch', 'partial-failure']],
  ['cross-run-disclosure-reuse-denied', ['disclosure']],
  ['disclosure-expires-before-model-dispatch', ['disclosure']],
  ['luna-unavailable-terra-fallback', ['luna-terra-fallback']],
  ['required-terra-unavailable', ['luna-terra-fallback']],
  ['dual-model-unavailable', ['dual-model-unavailable']],
  [
    'multiple-provider-writes-require-separate-turns',
    ['approval-interruption'],
  ],
  ['calendar-write-authenticated-visual-resume', ['approval-interruption']],
  ['typed-yes-cannot-approve', ['approval-interruption']],
] as const;
const browserEvidenceSpecs = [
  ['app.spec.ts', 'renders the desktop Today concept without runtime errors'],
  [
    'auth.spec.ts',
    'signs in through the cookie session and never offers public sign-up',
  ],
  [
    'auth.spec.ts',
    'surfaces authoritative session expiry and keeps Google identity separate',
  ],
  [
    'auth.spec.ts',
    'redeems an email-bound invitation and requires a separate sign-in',
  ],
  [
    'mobile.spec.ts',
    'keeps every immutable approval field and visual action above mobile navigation',
  ],
  [
    'mobile.spec.ts',
    'supports touch navigation and the narrow 320px viewport without overflow',
  ],
  [
    'powersync.production.spec.ts',
    'production preview boots the pinned encrypted PowerSync OPFS runtime',
  ],
  [
    'service-worker-update.production.spec.ts',
    'defers a real service worker update while an offline edit is pending',
  ],
  [
    'service-worker-update.production.spec.ts',
    'activates a real waiting service worker and reloads a clean client',
  ],
  ...[
    '/today',
    '/ask',
    '/schedule',
    '/finance',
    '/shopping',
    '/approvals',
    '/activity',
    '/settings',
  ].map((path) => [
    'routes.spec.ts',
    `${path} has a named heading and no serious WCAG violations`,
  ]),
  [
    'routes.spec.ts',
    'supports keyboard navigation through the visible skip link and named routes',
  ],
  [
    'voice.spec.ts',
    'records in memory, permits transcript correction, and revokes spoken audio',
  ],
  [
    'voice.spec.ts',
    'leaves no push-to-talk audio or transcript in durable browser storage',
  ],
  [
    'voice.spec.ts',
    'falls back to typed input when microphone access is unavailable',
  ],
] as const;

const loadReceiptWriter = async (): Promise<ReceiptWriterModule> =>
  (await import('../../scripts/release/write-acceptance-receipt.mjs')) as ReceiptWriterModule;

const loadDescriptorWriter = async (): Promise<DescriptorWriterModule> =>
  (await import('../../scripts/release/write-acceptance-descriptor.mjs')) as DescriptorWriterModule;

const loadProviderFreeProducer =
  async (): Promise<ProviderFreeProducerModule> =>
    (await import('../../scripts/release/write-provider-free-ci-evidence.mjs')) as ProviderFreeProducerModule;

const outputRoot = (name: string): string => {
  const root = join(
    repositoryRoot,
    'output',
    'test-provider-free-evidence',
    name,
  );
  outputRoots.push(root);
  return root;
};

const producerArguments = (
  profile: string,
  root: string,
  ...additional: readonly string[]
): readonly string[] => [
  '--profile',
  profile,
  '--receipts-root',
  root,
  '--source-sha',
  sourceSha,
  '--run-id',
  runId,
  '--observed-at',
  observedAt,
  ...additional,
];

const readJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(path, 'utf8')) as unknown;

const writeBrowserReport = async (
  name: string,
  mutate?: (report: Record<string, unknown>) => void,
): Promise<string> => {
  const root = outputRoot(`browser-report-${name}`);
  const path = join(root, 'playwright.json');
  const report: Record<string, unknown> = {
    suites: browserEvidenceSpecs.map(([file, title]) => ({
      title: file,
      file,
      specs: [
        {
          title,
          file,
          tests: [
            {
              projectName: 'production-chromium',
              status: 'expected',
              results: [{ status: 'passed' }],
            },
          ],
        },
      ],
    })),
    errors: [],
    stats: {
      expected: browserEvidenceSpecs.length,
      unexpected: 0,
      flaky: 0,
      skipped: 0,
    },
  };
  mutate?.(report);
  await mkdir(root, { recursive: true });
  await writeFile(path, `${JSON.stringify(report)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  return path;
};

const writeAgentCaseReport = async (
  name: string,
  mutate?: (report: Record<string, unknown>) => void,
): Promise<string> => {
  const root = outputRoot(`agent-case-report-${name}`);
  const path = join(root, 'agent-cases.json');
  const observations = (id: string) => ({
    deniedCapabilityIds:
      id === 'manager-forbidden-raw-tools'
        ? [
            'google-calendar.event.create',
            'database.raw-query',
            'credentials.vault.read',
            'finance.payment.create',
            'commerce.checkout',
          ]
        : id === 'indirect-retailer-prompt-injection'
          ? ['commerce.checkout', 'finance.private-records.read']
          : [],
    modelResolutions:
      id === 'route-scheduler-intent'
        ? [
            {
              status: 'resolved',
              requestedModel: 'gpt-5.6-luna',
              resolvedModel: 'gpt-5.6-luna',
            },
          ]
        : id === 'dependent-cross-domain-waves'
          ? [
              {
                status: 'resolved',
                requestedModel: 'gpt-5.6-terra',
                resolvedModel: 'gpt-5.6-terra',
              },
            ]
          : id === 'luna-unavailable-terra-fallback'
            ? [
                {
                  status: 'resolved',
                  requestedModel: 'gpt-5.6-luna',
                  resolvedModel: 'gpt-5.6-terra',
                },
              ]
            : [],
    approvalInterruptionCount:
      id === 'calendar-write-authenticated-visual-resume' ||
      id === 'typed-yes-cannot-approve'
        ? 1
        : 0,
    actionExecutionCount:
      id === 'calendar-write-authenticated-visual-resume' ? 1 : 0,
  });
  const report: Record<string, unknown> = {
    schemaVersion: 1,
    summary: {
      total: agentEvidenceCases.length,
      passed: agentEvidenceCases.length,
      failed: 0,
    },
    cases: agentEvidenceCases.map(([id, coverage]) => ({
      id,
      coverage,
      passed: true,
      observations: observations(id),
    })),
  };
  mutate?.(report);
  await mkdir(root, { recursive: true });
  await writeFile(path, `${JSON.stringify(report)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  return path;
};

const requiredEvalRuntimeTests = [
  {
    file: 'evals/runner.test.ts',
    fullName:
      'EMDO agent eval harness runs the complete deterministic safety and orchestration suite through one injected driver',
  },
  {
    file: 'evals/production-safety-integration.test.ts',
    fullName:
      'production-bound safety eval driver runs safety cases through the live toolbox policy and contract schemas',
  },
  {
    file: 'evals/orchestrator-integration.test.ts',
    fullName:
      'real AgentOrchestrator eval path passes central orchestration cases through the production runner and local trace adapter',
  },
  {
    file: 'evals/orchestrator-integration.test.ts',
    fullName:
      'real AgentOrchestrator eval path passes Luna fallback and fail-closed model cases through the production runner',
  },
  {
    file: 'evals/orchestrator-integration.test.ts',
    fullName:
      'real AgentOrchestrator eval path persists and resumes the exact approved proposal through the production runner',
  },
  {
    file: 'evals/orchestrator-integration.test.ts',
    fullName:
      'real AgentOrchestrator eval path rejects typed approval at the production resume boundary without executing the action',
  },
] as const;

const requiredBudgetTests = [
  {
    file: 'packages/agent-core/src/runner.sdk.test.ts',
    fullName:
      'OpenAI Agents SDK boundary blocks an over-limit input before spend reservation or SDK dispatch',
  },
  {
    file: 'packages/agent-core/src/runner.sdk.test.ts',
    fullName:
      'OpenAI Agents SDK boundary blocks new model work at the monthly limit before SDK dispatch',
  },
  {
    file: 'packages/agent-core/src/runner.sdk.test.ts',
    fullName:
      'OpenAI Agents SDK boundary surfaces the monthly warning and settles actual model usage',
  },
  {
    file: 'packages/agent-core/src/runner.sdk.test.ts',
    fullName:
      'OpenAI Agents SDK boundary enforces capability-call and wall-clock budgets inside the SDK boundary',
  },
] as const;

const writeVitestReport = async (
  name: string,
  requiredTests: readonly Readonly<{ file: string; fullName: string }>[],
  mutate?: (report: Record<string, unknown>) => void,
): Promise<string> => {
  const root = outputRoot(`vitest-report-${name}`);
  const path = join(root, 'vitest.json');
  const testsByFile = new Map<string, string[]>();
  for (const required of requiredTests) {
    const fullNames = testsByFile.get(required.file) ?? [];
    fullNames.push(required.fullName);
    testsByFile.set(required.file, fullNames);
  }
  const report: Record<string, unknown> = {
    numTotalTestSuites: testsByFile.size,
    numPassedTestSuites: testsByFile.size,
    numFailedTestSuites: 0,
    numPendingTestSuites: 0,
    numTotalTests: requiredTests.length,
    numPassedTests: requiredTests.length,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    success: true,
    testResults: [...testsByFile].map(([file, fullNames]) => ({
      name: join(repositoryRoot, file),
      status: 'passed',
      assertionResults: fullNames.map((fullName) => ({
        ancestorTitles: [],
        fullName,
        status: 'passed',
        title: fullName,
        failureMessages: [],
      })),
    })),
  };
  mutate?.(report);
  await mkdir(root, { recursive: true });
  await writeFile(path, `${JSON.stringify(report)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  return path;
};

afterEach(async () => {
  await Promise.all(
    outputRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe('validated acceptance receipt writer', () => {
  it('strict-validates canonical receipt content and refuses to overwrite evidence', async () => {
    const root = outputRoot('validated-writer');
    const receipt = {
      schemaVersion: 1,
      category: 'ci',
      id: 'application',
      sourceSha,
      environment: 'ci',
      observedAt,
      execution: {
        workflow: '.github/workflows/ci.yml',
        runId,
        headSha: sourceSha,
        event: 'push',
        conclusion: 'success',
      },
      result: {
        outcome: 'success',
        proof: {
          formatCheck: 'passed',
          lint: 'passed',
          typecheck: 'passed',
          unitTests: 'passed',
          build: 'passed',
          packageSmoke: 'passed',
        },
      },
    };
    const writer = await loadReceiptWriter();

    const result = await writer.writeValidatedAcceptanceReceiptAndDescriptor({
      receiptsRoot: root,
      category: 'ci',
      id: 'application',
      receipt,
    });

    expect(result.artifactName).toBe('artifacts/ci/application.json');
    expect(await readFile(join(root, result.artifactName), 'utf8')).toBe(
      `${canonicalJson(receipt)}\n`,
    );
    expect(
      validateAcceptanceDescriptor(await readJson(result.descriptorPath), {
        category: 'ci',
        id: 'application',
      }),
    ).toMatchObject({ id: 'application' });
    await expect(
      writer.writeValidatedAcceptanceReceiptAndDescriptor({
        receiptsRoot: root,
        category: 'ci',
        id: 'application',
        receipt,
      }),
    ).rejects.toThrow();

    await expect(
      writer.writeValidatedAcceptanceReceiptAndDescriptor({
        receiptsRoot: outputRoot('invalid-writer'),
        category: 'ci',
        id: 'application',
        receipt: {
          ...receipt,
          result: { outcome: 'success', proof: { genericPassed: true } },
        },
      }),
    ).rejects.toThrow('receipt.result.proof');
  });

  it('persists the receipt state validated before asynchronous filesystem work', async () => {
    const root = outputRoot('validated-writer-snapshot');
    const receipt = {
      schemaVersion: 1,
      category: 'ci',
      id: 'application',
      sourceSha,
      environment: 'ci',
      observedAt,
      execution: {
        workflow: '.github/workflows/ci.yml',
        runId,
        headSha: sourceSha,
        event: 'push',
        conclusion: 'success',
      },
      result: {
        outcome: 'success',
        proof: {
          formatCheck: 'passed',
          lint: 'passed',
          typecheck: 'passed',
          unitTests: 'passed',
          build: 'passed',
          packageSmoke: 'passed',
        },
      },
    };
    const writer = await loadReceiptWriter();

    const pendingWrite = writer.writeValidatedAcceptanceReceiptAndDescriptor({
      receiptsRoot: root,
      category: 'ci',
      id: 'application',
      receipt,
    });
    receipt.sourceSha = 'b'.repeat(40);
    receipt.execution.headSha = 'b'.repeat(40);
    receipt.execution.runId = '9001';

    const result = await pendingWrite;
    expect(await readJson(join(root, result.artifactName))).toMatchObject({
      sourceSha,
      execution: { headSha: sourceSha, runId },
    });
  });

  it('refuses a descriptor directory symlink that escapes the evidence root', async () => {
    const root = outputRoot('descriptor-symlink');
    const outside = outputRoot('descriptor-symlink-outside');
    await mkdir(join(root, 'descriptors'), { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(root, 'descriptors', 'ci'));
    const writer = await loadReceiptWriter();
    const receipt = {
      schemaVersion: 1,
      category: 'ci',
      id: 'application',
      sourceSha,
      environment: 'ci',
      observedAt,
      execution: {
        workflow: '.github/workflows/ci.yml',
        runId,
        headSha: sourceSha,
        event: 'push',
        conclusion: 'success',
      },
      result: {
        outcome: 'success',
        proof: {
          formatCheck: 'passed',
          lint: 'passed',
          typecheck: 'passed',
          unitTests: 'passed',
          build: 'passed',
          packageSmoke: 'passed',
        },
      },
    };

    await expect(
      writer.writeValidatedAcceptanceReceiptAndDescriptor({
        receiptsRoot: root,
        category: 'ci',
        id: 'application',
        receipt,
      }),
    ).rejects.toThrow(/descriptor.*root/iu);
    await expect(readFile(join(outside, 'application.json'))).rejects.toThrow();
  });

  it('rejects a symlinked descriptor parent without creating a directory outside the receipt root', async () => {
    const root = outputRoot('descriptor-parent-symlink');
    const outside = outputRoot('descriptor-parent-symlink-outside');
    await mkdir(root, { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(root, 'descriptors'));
    const writer = await loadReceiptWriter();
    const receipt = {
      schemaVersion: 1,
      category: 'ci',
      id: 'application',
      sourceSha,
      environment: 'ci',
      observedAt,
      execution: {
        workflow: '.github/workflows/ci.yml',
        runId,
        headSha: sourceSha,
        event: 'push',
        conclusion: 'success',
      },
      result: {
        outcome: 'success',
        proof: {
          formatCheck: 'passed',
          lint: 'passed',
          typecheck: 'passed',
          unitTests: 'passed',
          build: 'passed',
          packageSmoke: 'passed',
        },
      },
    };

    await expect(
      writer.writeValidatedAcceptanceReceiptAndDescriptor({
        receiptsRoot: root,
        category: 'ci',
        id: 'application',
        receipt,
      }),
    ).rejects.toThrow(/descriptor.*root/iu);
    await expect(lstat(join(outside, 'ci'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects a symlinked descriptor parent without direct-writer side effects', async () => {
    const root = outputRoot('direct-descriptor-parent-symlink');
    const outside = outputRoot('direct-descriptor-parent-symlink-outside');
    const artifactName = 'artifacts/ci/application.json';
    const receipt = {
      schemaVersion: 1,
      category: 'ci',
      id: 'application',
      sourceSha,
      environment: 'ci',
      observedAt,
      execution: {
        workflow: '.github/workflows/ci.yml',
        runId,
        headSha: sourceSha,
        event: 'push',
        conclusion: 'success',
      },
      result: {
        outcome: 'success',
        proof: {
          formatCheck: 'passed',
          lint: 'passed',
          typecheck: 'passed',
          unitTests: 'passed',
          build: 'passed',
          packageSmoke: 'passed',
        },
      },
    };
    await mkdir(join(root, 'artifacts', 'ci'), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(
      join(root, artifactName),
      `${canonicalJson(receipt)}\n`,
      'utf8',
    );
    await symlink(outside, join(root, 'descriptors'));
    const writer = await loadDescriptorWriter();

    await expect(
      writer.runAcceptanceDescriptorWrite([
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
      ]),
    ).rejects.toThrow(/descriptor.*root/iu);
    await expect(lstat(join(outside, 'ci'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('refuses a symlinked receipt root when the descriptor writer is invoked directly', async () => {
    const outside = outputRoot('descriptor-root-outside');
    const linkedRoot = outputRoot('descriptor-root-link');
    const artifactName = 'artifacts/ci/application.json';
    const receipt = {
      schemaVersion: 1,
      category: 'ci',
      id: 'application',
      sourceSha,
      environment: 'ci',
      observedAt,
      execution: {
        workflow: '.github/workflows/ci.yml',
        runId,
        headSha: sourceSha,
        event: 'push',
        conclusion: 'success',
      },
      result: {
        outcome: 'success',
        proof: {
          formatCheck: 'passed',
          lint: 'passed',
          typecheck: 'passed',
          unitTests: 'passed',
          build: 'passed',
          packageSmoke: 'passed',
        },
      },
    };
    await mkdir(join(outside, 'artifacts', 'ci'), { recursive: true });
    await writeFile(
      join(outside, artifactName),
      `${canonicalJson(receipt)}\n`,
      'utf8',
    );
    await symlink(outside, linkedRoot);
    const writer = await loadDescriptorWriter();

    await expect(
      writer.runAcceptanceDescriptorWrite([
        '--category',
        'ci',
        '--id',
        'application',
        '--receipts-root',
        linkedRoot,
        '--artifact-name',
        artifactName,
        '--observed-at',
        observedAt,
      ]),
    ).rejects.toThrow(/root.*regular directory/iu);
    await expect(
      readFile(join(outside, 'descriptors', 'ci', 'application.json')),
    ).rejects.toThrow();
  });
});

describe('provider-free CI evidence profiles', () => {
  it('writes exact source-quality and static-security CI receipts', async () => {
    const producer = await loadProviderFreeProducer();
    for (const profile of ['application', 'infrastructure'] as const) {
      const root = outputRoot(profile);
      await expect(
        producer.runProviderFreeCiEvidenceWrite(
          producerArguments(profile, root),
        ),
      ).resolves.toEqual({ receiptCount: 1 });
      const source = await readFile(
        join(root, `artifacts/ci/${profile}.json`),
        'utf8',
      );
      expect(
        parseAcceptanceReceipt(source, {
          category: 'ci',
          id: profile,
          context: undefined,
        }).verification,
      ).toMatchObject({ id: profile, sourceSha, environment: 'ci' });
    }
  });

  it('writes only the selected release-package image receipt', async () => {
    const producer = await loadProviderFreeProducer();
    const root = outputRoot('container');
    await expect(
      producer.runProviderFreeCiEvidenceWrite(
        producerArguments('container-build-worker', root),
      ),
    ).resolves.toEqual({ receiptCount: 1 });

    const worker = await readFile(
      join(root, 'artifacts/ci/container-build-worker.json'),
      'utf8',
    );
    expect(
      parseAcceptanceReceipt(worker, {
        category: 'ci',
        id: 'container-build-worker',
        context: undefined,
      }).verification.id,
    ).toBe('container-build-worker');
    await expect(
      readFile(join(root, 'artifacts/ci/container-build-api.json'), 'utf8'),
    ).rejects.toThrow();
  });

  it('writes the eval job and only the two provider-free runtime safety gates', async () => {
    const producer = await loadProviderFreeProducer();
    const root = outputRoot('agent-evals');
    const [caseReport, runtimeReport, budgetReport] = await Promise.all([
      writeAgentCaseReport('complete'),
      writeVitestReport('runtime', requiredEvalRuntimeTests),
      writeVitestReport('budget', requiredBudgetTests),
    ]);
    await expect(
      producer.runProviderFreeCiEvidenceWrite(
        producerArguments(
          'agent-evals',
          root,
          '--eval-case-report',
          caseReport,
          '--eval-runtime-report',
          runtimeReport,
          '--eval-budget-report',
          budgetReport,
        ),
      ),
    ).resolves.toEqual({ receiptCount: 3 });

    for (const [category, id] of [
      ['ci', 'agent-evals'],
      ['gates', 'agent-evals-provider-free'],
      ['gates', 'agent-evals-production-runtime'],
    ] as const) {
      const source = await readFile(
        join(root, `artifacts/${category}/${id}.json`),
        'utf8',
      );
      expect(
        parseAcceptanceReceipt(source, { category, id, context: undefined })
          .verification.id,
      ).toBe(id);
    }
    expect(
      (await readJson(join(root, 'artifacts/ci/agent-evals.json'))) as {
        readonly result: { readonly proof: { readonly evalCaseCount: number } };
      },
    ).toMatchObject({ result: { proof: { evalCaseCount: 17 } } });
    await expect(
      readFile(join(root, 'artifacts/providers/openai-agents.json')),
    ).rejects.toThrow();
  });

  it('rejects spoofed eval counts and reports missing runtime or usage-budget assertions', async () => {
    const producer = await loadProviderFreeProducer();
    const runtimeReport = await writeVitestReport(
      'runtime-negative',
      requiredEvalRuntimeTests,
    );
    const validBudgetReport = await writeVitestReport(
      'budget-valid-negative',
      requiredBudgetTests,
    );
    const missingBudgetReport = await writeVitestReport(
      'budget-negative',
      requiredBudgetTests.slice(1),
    );
    const spoofedCases = await writeAgentCaseReport(
      'spoofed-count',
      (value) => {
        (value.summary as Record<string, number>).total = 24;
      },
    );

    await expect(
      producer.runProviderFreeCiEvidenceWrite(
        producerArguments(
          'agent-evals',
          outputRoot('spoofed-agent-count'),
          '--eval-case-report',
          spoofedCases,
          '--eval-runtime-report',
          runtimeReport,
          '--eval-budget-report',
          validBudgetReport,
        ),
      ),
    ).rejects.toThrow(/agent eval evidence report/iu);

    const validCases = await writeAgentCaseReport('valid-negative');
    await expect(
      producer.runProviderFreeCiEvidenceWrite(
        producerArguments(
          'agent-evals',
          outputRoot('missing-budget-assertion'),
          '--eval-case-report',
          validCases,
          '--eval-runtime-report',
          runtimeReport,
          '--eval-budget-report',
          missingBudgetReport,
        ),
      ),
    ).rejects.toThrow(/required agent usage-budget test/iu);
  });

  it('rejects internally inconsistent Vitest suite aggregates', async () => {
    const producer = await loadProviderFreeProducer();
    const runtimeReport = await writeVitestReport(
      'runtime-valid-aggregate-negative',
      requiredEvalRuntimeTests,
    );
    const budgetReport = await writeVitestReport(
      'budget-invalid-aggregate',
      requiredBudgetTests,
      (value) => {
        value.numTotalTestSuites = 9;
      },
    );
    const cases = await writeAgentCaseReport('valid-aggregate-negative');

    await expect(
      producer.runProviderFreeCiEvidenceWrite(
        producerArguments(
          'agent-evals',
          outputRoot('invalid-agent-suite-aggregate'),
          '--eval-case-report',
          cases,
          '--eval-runtime-report',
          runtimeReport,
          '--eval-budget-report',
          budgetReport,
        ),
      ),
    ).rejects.toThrow(/agent eval evidence report/iu);
  });

  it('rejects a required Vitest assertion reported from the wrong source file', async () => {
    const producer = await loadProviderFreeProducer();
    const runtimeReport = await writeVitestReport(
      'runtime-wrong-source',
      requiredEvalRuntimeTests,
      (value) => {
        const results = value.testResults as Array<{ name: string }>;
        results[0]!.name = join(repositoryRoot, 'evals', 'spoofed.test.ts');
      },
    );
    const budgetReport = await writeVitestReport(
      'budget-valid-wrong-source',
      requiredBudgetTests,
    );
    const cases = await writeAgentCaseReport('valid-wrong-source');

    await expect(
      producer.runProviderFreeCiEvidenceWrite(
        producerArguments(
          'agent-evals',
          outputRoot('invalid-agent-test-source'),
          '--eval-case-report',
          cases,
          '--eval-runtime-report',
          runtimeReport,
          '--eval-budget-report',
          budgetReport,
        ),
      ),
    ).rejects.toThrow(/required agent runtime test/iu);
  });

  it('rejects duplicate Vitest assertions even when aggregate counts agree', async () => {
    const producer = await loadProviderFreeProducer();
    const runtimeReport = await writeVitestReport(
      'runtime-valid-duplicate-negative',
      requiredEvalRuntimeTests,
    );
    const budgetReport = await writeVitestReport(
      'budget-duplicate',
      requiredBudgetTests,
      (value) => {
        const results = value.testResults as Array<{
          assertionResults: Array<Record<string, unknown>>;
        }>;
        const duplicate = results[0]!.assertionResults[0];
        if (!duplicate) throw new Error('invalid Vitest fixture');
        results[0]!.assertionResults.push({ ...duplicate });
        value.numTotalTests = Number(value.numTotalTests) + 1;
        value.numPassedTests = Number(value.numPassedTests) + 1;
      },
    );
    const cases = await writeAgentCaseReport('valid-duplicate-negative');

    await expect(
      producer.runProviderFreeCiEvidenceWrite(
        producerArguments(
          'agent-evals',
          outputRoot('invalid-agent-duplicate-assertion'),
          '--eval-case-report',
          cases,
          '--eval-runtime-report',
          runtimeReport,
          '--eval-budget-report',
          budgetReport,
        ),
      ),
    ).rejects.toThrow(/agent eval evidence report/iu);
  });

  it('writes only browser claims completely proven by the exact production report', async () => {
    const producer = await loadProviderFreeProducer();
    const root = outputRoot('browser');
    const report = await writeBrowserReport('complete');
    await expect(
      producer.runProviderFreeCiEvidenceWrite(
        producerArguments(
          'browser-production-preview',
          root,
          '--browser-report',
          report,
        ),
      ),
    ).resolves.toEqual({ receiptCount: 4 });

    for (const [category, id] of [
      ['ci', 'browser-production-preview'],
      ['gates', 'production-preview-browser'],
      ['gates', 'voice-ptt-storage-playback'],
      ['gates', 'service-worker-safe-update'],
    ] as const) {
      const source = await readFile(
        join(root, `artifacts/${category}/${id}.json`),
        'utf8',
      );
      expect(
        parseAcceptanceReceipt(source, { category, id, context: undefined })
          .verification.id,
      ).toBe(id);
    }
    await expect(
      readJson(join(root, 'artifacts/gates/voice-ptt-storage-playback.json')),
    ).resolves.toMatchObject({
      result: {
        proof: {
          audioPersisted: false,
          transcriptCorrection: 'passed',
          captions: 'passed',
          playbackControls: 'passed',
          objectUrlRevoked: true,
        },
      },
    });
    await expect(
      readJson(join(root, 'artifacts/gates/service-worker-safe-update.json')),
    ).resolves.toMatchObject({
      result: {
        proof: {
          pendingChangesPreserved: true,
          activationDeferred: true,
          reloadRecovery: 'passed',
        },
      },
    });
    for (const absent of [
      'wcag-2.2-aa',
      'pwa-install-offline-reopen',
      'web-push-preferences',
      'powersync-browser-connect-sync-entities-roundtrip',
    ]) {
      await expect(
        readFile(join(root, `artifacts/gates/${absent}.json`)),
      ).rejects.toThrow();
    }
  });

  it('rejects an aggregate-green browser report that omits or replaces a required semantic test', async () => {
    const producer = await loadProviderFreeProducer();
    const report = await writeBrowserReport('missing-responsive', (value) => {
      const suites = value.suites as Array<{
        specs: Array<{ title: string }>;
      }>;
      const responsive = suites.find(
        ({ specs }) =>
          specs[0]?.title ===
          'supports touch navigation and the narrow 320px viewport without overflow',
      );
      if (!responsive?.specs[0]) throw new Error('invalid test fixture');
      responsive.specs[0].title = 'runs an unrelated all-green browser check';
    });

    await expect(
      producer.runProviderFreeCiEvidenceWrite(
        producerArguments(
          'browser-production-preview',
          outputRoot('missing-browser-claim'),
          '--browser-report',
          report,
        ),
      ),
    ).rejects.toThrow(/required browser evidence test/iu);
  });

  it('requires every exact test identity from the official production suite', async () => {
    const producer = await loadProviderFreeProducer();
    for (const [index, [file, title]] of browserEvidenceSpecs.entries()) {
      const report = await writeBrowserReport(
        `replaced-required-${index}`,
        (value) => {
          const suites = value.suites as Array<{
            file: string;
            specs: Array<{ title: string }>;
          }>;
          const suite = suites.find(
            (candidate) =>
              candidate.file === file && candidate.specs[0]?.title === title,
          );
          if (!suite?.specs[0]) throw new Error('invalid test fixture');
          suite.specs[0].title = `unrelated replacement for ${title}`;
        },
      );

      await expect(
        producer.runProviderFreeCiEvidenceWrite(
          producerArguments(
            'browser-production-preview',
            outputRoot(`missing-required-${index}`),
            '--browser-report',
            report,
          ),
        ),
        `${file} :: ${title}`,
      ).rejects.toThrow(/required browser evidence test/iu);
    }
  });

  it('rejects a browser report with a failed, flaky, skipped, or non-production project', async () => {
    const producer = await loadProviderFreeProducer();
    for (const [name, mutate] of [
      [
        'failed',
        (value: Record<string, unknown>) => {
          const stats = value.stats as Record<string, number>;
          stats.expected -= 1;
          stats.unexpected = 1;
        },
      ],
      [
        'wrong-project',
        (value: Record<string, unknown>) => {
          const suites = value.suites as Array<{
            specs: Array<{ tests: Array<{ projectName: string }> }>;
          }>;
          suites[0]!.specs[0]!.tests[0]!.projectName = 'development-chromium';
        },
      ],
      [
        'malformed-errors',
        (value: Record<string, unknown>) => {
          value.errors = 'reporter error was not an array';
        },
      ],
    ] as const) {
      const report = await writeBrowserReport(name, mutate);
      await expect(
        producer.runProviderFreeCiEvidenceWrite(
          producerArguments(
            'browser-production-preview',
            outputRoot(`invalid-browser-${name}`),
            '--browser-report',
            report,
          ),
        ),
      ).rejects.toThrow(/browser evidence report/iu);
    }
  });

  it('refuses symlinked execution reports instead of following caller-controlled paths', async () => {
    const producer = await loadProviderFreeProducer();
    const report = await writeBrowserReport('symlink-target');
    const linkRoot = outputRoot('browser-report-symlink');
    const linkedReport = join(linkRoot, 'playwright.json');
    await mkdir(linkRoot, { recursive: true });
    await symlink(report, linkedReport);

    await expect(
      producer.runProviderFreeCiEvidenceWrite(
        producerArguments(
          'browser-production-preview',
          outputRoot('browser-report-symlink-receipts'),
          '--browser-report',
          linkedReport,
        ),
      ),
    ).rejects.toThrow(/browser evidence report/iu);
  });

  it('rejects unknown profiles, invalid counts, and extra arguments', async () => {
    const producer = await loadProviderFreeProducer();
    await expect(
      producer.runProviderFreeCiEvidenceWrite(
        producerArguments('live-provider-smoke', outputRoot('unknown')),
      ),
    ).rejects.toThrow('profile');
    await expect(
      producer.runProviderFreeCiEvidenceWrite(
        producerArguments('agent-evals', outputRoot('missing-report')),
      ),
    ).rejects.toThrow('report');
    await expect(
      producer.runProviderFreeCiEvidenceWrite([
        ...producerArguments('application', outputRoot('extra')),
        '--provider-live',
        'true',
      ]),
    ).rejects.toThrow('arguments');
  });
});

describe('provider-free receipt workflow wiring', () => {
  it('records fixed semantic profiles after their real jobs and never loops over generic payloads', async () => {
    const [ci, productionConfig] = await Promise.all([
      readFile(join(repositoryRoot, '.github/workflows/ci.yml'), 'utf8'),
      readFile(
        join(repositoryRoot, 'apps/web/playwright.production.config.ts'),
        'utf8',
      ),
    ]);

    for (const profile of [
      'application',
      'infrastructure',
      'container-build-${{ matrix.target }}',
      'browser-production-preview',
      'agent-evals',
    ]) {
      expect(ci).toContain(`--profile ${profile}`);
    }
    expect(ci).toContain('write-provider-free-ci-evidence.mjs');
    expect(ci).toContain('--browser-report "$BROWSER_REPORT"');
    expect(ci).not.toContain('--browser-test-count');
    expect(ci).toContain('--eval-case-report "$EVAL_CASE_REPORT"');
    expect(ci).toContain('--eval-runtime-report "$EVAL_RUNTIME_REPORT"');
    expect(ci).toContain('--eval-budget-report "$EVAL_BUDGET_REPORT"');
    expect(ci).not.toContain('--eval-case-count');
    expect(ci).toContain('pnpm exec vitest run infra/tests');
    expect(ci).toContain('shellcheck infra/compose/provision-runtime.sh');
    expect(ci).toContain('actions/download-artifact@');
    expect(ci).toContain('merge-multiple: true');
    expect(ci).not.toContain('CI_RECEIPT_ID');
    expect(ci).not.toContain('needs: JSON.parse');
    expect(ci).not.toContain('genericPassed');
    expect(productionConfig).not.toContain(
      'testMatch: /production\\.spec\\.ts/u',
    );
    expect(productionConfig).toContain('workers: 1');
  });

  it('keeps every producer after its successful suite and restricted to push evidence', async () => {
    const ci = await readFile(
      join(repositoryRoot, '.github/workflows/ci.yml'),
      'utf8',
    );
    const jobBlock = (id: string): string => {
      const startMarker = `\n  ${id}:\n`;
      const start = ci.indexOf(startMarker);
      if (start < 0) throw new Error(`missing workflow job: ${id}`);
      const tail = ci.slice(start + startMarker.length);
      const next = /\n {2}[a-z0-9-]+:\n/u.exec(tail);
      return next ? tail.slice(0, next.index) : tail;
    };
    for (const [job, suiteMarker, producerMarker] of [
      ['application', 'pnpm format:check', '--profile application'],
      [
        'agent-evals',
        '--config evals/vitest.config.mjs',
        '--profile agent-evals',
      ],
      [
        'browser-production-preview',
        'pnpm --filter @emdo/web run test:e2e:production',
        '--profile browser-production-preview',
      ],
      [
        'infrastructure',
        'pnpm exec vitest run infra/tests',
        '--profile infrastructure',
      ],
      [
        'container-build',
        'docker/build-push-action@',
        '--profile container-build-${{ matrix.target }}',
      ],
    ] as const) {
      const block = jobBlock(job);
      expect(block.indexOf(suiteMarker), job).toBeGreaterThanOrEqual(0);
      expect(block.indexOf(producerMarker), job).toBeGreaterThan(
        block.indexOf(suiteMarker),
      );
      const producerStart = block.lastIndexOf(
        '- name: Record',
        block.indexOf(producerMarker),
      );
      expect(producerStart, job).toBeGreaterThanOrEqual(0);
      expect(
        block.slice(producerStart, block.indexOf(producerMarker)),
        job,
      ).toContain("if: github.event_name == 'push' && success()");
      expect(block, job).not.toContain('continue-on-error');
    }

    const aggregation = jobBlock('acceptance-ci-receipts');
    expect(aggregation).toContain("if: github.event_name == 'push'");
    for (const required of [
      'application',
      'infrastructure',
      'container-build',
      'browser-production-preview',
      'agent-evals',
      'postgres-integration',
    ]) {
      expect(aggregation).toContain(required);
    }
    expect(aggregation).not.toContain('write-provider-free-ci-evidence.mjs');
    expect(aggregation).not.toContain('pwa-install-offline-reopen');
    expect(aggregation).toContain('voice-ptt-storage-playback');
    expect(aggregation).toContain('service-worker-safe-update');
  });
});
