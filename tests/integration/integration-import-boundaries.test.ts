import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const serverCapableIntegrationSpecifiers = [
  '@emdo/integrations',
  '@emdo/integrations/commerce',
  '@emdo/integrations/email',
  '@emdo/integrations/google-calendar',
  '@emdo/integrations/google-oauth-server',
  '@emdo/integrations/maps',
  '@emdo/integrations/openai',
  '@emdo/integrations/push',
  '@emdo/integrations/vault',
] as const;

const eslint = new ESLint();

const lintSource = async (filePath: string, source: string) => {
  const [result] = await eslint.lintText(source, { filePath });
  return result?.messages ?? [];
};

const lintImport = (filePath: string, specifier: string) =>
  lintSource(
    filePath,
    `import { boundaryProbe } from ${JSON.stringify(specifier)}; void boundaryProbe;`,
  );

const relativeBoundaryProbes = [
  {
    layer: 'browser',
    filePath: 'apps/web/src/integration-boundary-probe.ts',
    specifier: '../../../packages/integrations/src/google/calendar.js',
  },
  {
    layer: 'agent',
    filePath: 'packages/agents/manager/src/integration-boundary-probe.ts',
    specifier: '../../../integrations/src/google/calendar.js',
  },
] as const;

describe('integration import boundaries', () => {
  it.each(serverCapableIntegrationSpecifiers)(
    'rejects %s from browser code',
    async (specifier) => {
      const messages = await lintImport(
        'apps/web/src/integration-boundary-probe.ts',
        specifier,
      );

      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'no-restricted-imports',
            severity: 2,
          }),
        ]),
      );
    },
  );

  it.each(serverCapableIntegrationSpecifiers)(
    'rejects %s from agent code',
    async (specifier) => {
      const messages = await lintImport(
        'packages/agents/manager/src/integration-boundary-probe.ts',
        specifier,
      );

      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'no-restricted-imports',
            severity: 2,
          }),
        ]),
      );
    },
  );

  it.each(relativeBoundaryProbes)(
    'rejects relative static imports from $layer code',
    async ({ filePath, specifier }) => {
      const messages = await lintImport(filePath, specifier);

      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'no-restricted-imports',
            severity: 2,
          }),
        ]),
      );
    },
  );

  it.each(relativeBoundaryProbes)(
    'rejects relative re-exports from $layer code',
    async ({ filePath, specifier }) => {
      const messages = await lintSource(
        filePath,
        `export { boundaryProbe } from ${JSON.stringify(specifier)};`,
      );

      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'no-restricted-imports',
            severity: 2,
          }),
        ]),
      );
    },
  );

  it.each(relativeBoundaryProbes)(
    'rejects aliased and relative dynamic imports from $layer code',
    async ({ filePath, specifier }) => {
      const messages = await lintSource(
        filePath,
        `void import('@emdo/integrations/openai'); void import(${JSON.stringify(specifier)});`,
      );

      expect(
        messages.filter(({ ruleId }) => ruleId === 'no-restricted-syntax'),
      ).toHaveLength(2);
    },
  );

  it.each([
    'apps/api/src/integration-boundary-probe.ts',
    'apps/worker/src/integration-boundary-probe.ts',
  ])('allows server composition from %s', async (filePath) => {
    const messages = await lintSource(
      filePath,
      "import { boundaryProbe } from '@emdo/integrations/google-oauth-server'; void boundaryProbe; void import('@emdo/integrations/openai');",
    );

    expect(
      messages.filter(
        ({ ruleId }) =>
          ruleId === 'no-restricted-imports' ||
          ruleId === 'no-restricted-syntax',
      ),
    ).toEqual([]);
  });
});
