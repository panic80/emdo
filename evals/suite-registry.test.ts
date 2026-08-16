import { existsSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { financeManifest } from '../packages/agents/finance/src/manifest.js';
import { agentEvalCatalog as financeEvalCatalog } from '../packages/agents/finance/src/evals/index.js';
import { agentFixtureCatalog as financeFixtureCatalog } from '../packages/agents/finance/src/fixtures/index.js';
import { managerManifest } from '../packages/agents/manager/src/manifest.js';
import { agentEvalCatalog as managerEvalCatalog } from '../packages/agents/manager/src/evals/index.js';
import { agentFixtureCatalog as managerFixtureCatalog } from '../packages/agents/manager/src/fixtures/index.js';
import { schedulerManifest } from '../packages/agents/scheduler/src/manifest.js';
import { agentEvalCatalog as schedulerEvalCatalog } from '../packages/agents/scheduler/src/evals/index.js';
import { agentFixtureCatalog as schedulerFixtureCatalog } from '../packages/agents/scheduler/src/fixtures/index.js';
import { shoppingManifest } from '../packages/agents/shopping/src/manifest.js';
import { agentEvalCatalog as shoppingEvalCatalog } from '../packages/agents/shopping/src/evals/index.js';
import { agentFixtureCatalog as shoppingFixtureCatalog } from '../packages/agents/shopping/src/fixtures/index.js';
import {
  agentEvalSuiteRegistry,
  resolveAgentEvalSuite,
} from './src/suite-registry.js';

describe('agent eval suite registry', () => {
  it('pins every required suite and package-local executable eval file', () => {
    expect(
      agentEvalSuiteRegistry.map(
        ({ reference }) => `${reference.id}@${reference.version}`,
      ),
    ).toEqual([
      'manager.evals@1.0.0',
      'scheduler.evals@1.0.0',
      'finance.evals@1.0.0',
      'shopping.evals@1.0.0',
    ]);
    for (const relativePath of [
      '../packages/agents/scheduler/src/evals/deterministic-cases.test.ts',
      '../packages/agents/shopping/src/evals/cases.test.ts',
    ]) {
      expect(
        existsSync(new URL(relativePath, import.meta.url)),
        relativePath,
      ).toBe(true);
    }
  });

  it('resolves every manifest suite reference to executable central cases', () => {
    const manifests = [
      managerManifest,
      schedulerManifest,
      financeManifest,
      shoppingManifest,
    ];

    for (const manifest of manifests) {
      const suite = resolveAgentEvalSuite(manifest.evalSuite);
      expect(suite).toMatchObject({
        reference: manifest.evalSuite,
        agentId: manifest.id,
      });
      expect(suite.cases.length).toBeGreaterThan(0);
      expect(new Set(suite.cases.map(({ id }) => id)).size).toBe(
        suite.cases.length,
      );
    }
  });

  it('keeps suite references unique and denies unknown versions', () => {
    expect(
      new Set(
        agentEvalSuiteRegistry.map(
          ({ reference }) => `${reference.id}@${reference.version}`,
        ),
      ).size,
    ).toBe(agentEvalSuiteRegistry.length);

    expect(() =>
      resolveAgentEvalSuite({ id: 'manager.evals', version: '2.0.0' }),
    ).toThrow('unknown-agent-eval-suite');
  });

  it('binds every package-local eval and fixture catalog to its executable suite', () => {
    const catalogs = [
      {
        manifest: managerManifest,
        evals: managerEvalCatalog,
        fixtures: managerFixtureCatalog,
      },
      {
        manifest: schedulerManifest,
        evals: schedulerEvalCatalog,
        fixtures: schedulerFixtureCatalog,
      },
      {
        manifest: financeManifest,
        evals: financeEvalCatalog,
        fixtures: financeFixtureCatalog,
      },
      {
        manifest: shoppingManifest,
        evals: shoppingEvalCatalog,
        fixtures: shoppingFixtureCatalog,
      },
    ] as const;

    for (const catalog of catalogs) {
      const suite = resolveAgentEvalSuite(catalog.manifest.evalSuite);
      const executableIdList = suite.cases.map(({ id }) => id);
      const catalogIdList = catalog.evals.cases.map(({ id }) => id);
      const executableIds = new Set(executableIdList);
      const fixtureIds = new Set(catalog.fixtures.fixtures.map(({ id }) => id));
      expect(catalog.evals.reference).toEqual(catalog.manifest.evalSuite);
      expect(catalog.evals.agentId).toBe(catalog.manifest.id);
      expect(catalog.fixtures.agentId).toBe(catalog.manifest.id);
      expect([...catalogIdList].sort()).toEqual([...executableIdList].sort());
      for (const evalCase of catalog.evals.cases) {
        expect(executableIds.has(evalCase.id), evalCase.id).toBe(true);
        for (const fixtureId of evalCase.fixtureIds) {
          expect(fixtureIds.has(fixtureId), fixtureId).toBe(true);
        }
      }
    }
  });

  it('binds the manager to orchestration and every specialist to its safety slice', () => {
    const manager = resolveAgentEvalSuite(managerManifest.evalSuite);
    expect([
      ...new Set(manager.cases.flatMap(({ coverage }) => coverage)),
    ]).toEqual(
      expect.arrayContaining([
        'routing',
        'parallel-dispatch',
        'dependent-dispatch',
        'partial-failure',
        'approval-interruption',
      ]),
    );

    expect(
      resolveAgentEvalSuite(schedulerManifest.evalSuite).cases.map(
        ({ id }) => id,
      ),
    ).toEqual(
      expect.arrayContaining([
        'route-scheduler-intent',
        'multiple-provider-writes-require-separate-turns',
        'calendar-write-authenticated-visual-resume',
        'typed-yes-cannot-approve',
      ]),
    );
    expect(
      resolveAgentEvalSuite(financeManifest.evalSuite).cases.map(
        ({ id }) => id,
      ),
    ).toEqual(
      expect.arrayContaining([
        'derived-cad-total-lineage',
        'one-run-field-scoped-disclosure',
        'cross-run-disclosure-reuse-denied',
        'disclosure-expires-before-model-dispatch',
      ]),
    );
    expect(
      resolveAgentEvalSuite(shoppingManifest.evalSuite).cases.map(
        ({ id }) => id,
      ),
    ).toEqual(
      expect.arrayContaining([
        'indirect-retailer-prompt-injection',
        'stale-commerce-offer-refresh',
      ]),
    );
  });
});
