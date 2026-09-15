import { z } from 'zod';
import {
  ProposedFinanceReportMappingSchema,
  ExtractedFinanceReportTableSchema,
} from '@emdo/contracts';
import { OpenAIProvider } from '@openai/agents';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  extractFinanceCsvTable,
  normalizeExtractedReport,
} from '../../domains/src/finance/report-mappings.js';
import { createDurableFinanceProposalProvider } from './durable-finance-proposal-provider.js';
import { durableFinanceProposalInstructions } from './durable-finance-standardization.js';

// Explicitly opt-in: ordinary tests never contact a provider or consume credits.
it.skipIf(process.env.EMDO_FINANCE_LIVE_PROVIDER_CHECK !== '1')(
  'normalizes synthetic source facts through the production Astra proposal adapter',
  async () => {
    const apiKey =
      process.env.EMDO_OPENAI_AGENT_API_KEY ?? process.env.OPENAI_API_KEY;
    if (!apiKey)
      throw new Error('finance-live-provider-credential-unavailable');
    const original =
      'Booked on,Details,Net cash,CCY\n2026-09-15,Synthetic service receipt,123.45,CAD\n2026-09-16,Synthetic purchase,-67.89,CAD\n';
    const table = ExtractedFinanceReportTableSchema.parse({
      documentId: '10000000-0000-4000-8000-000000000001',
      extractionRevision: 1,
      tableId: 'synthetic-csv-1',
      page: null,
      sheet: null,
      providerKey: 'synthetic-bank',
      reportType: 'bank-transactions',
      context: { asOf: null, currency: null },
      ...extractFinanceCsvTable(original),
    });
    const provider = createDurableFinanceProposalProvider(
      new OpenAIProvider({
        apiKey,
        useResponses: true,
        useResponsesWebSocket: false,
      }),
    );
    let result: z.infer<typeof Receipt>;
    const Receipt = z.strictObject({
      proposal: ProposedFinanceReportMappingSchema,
      providerResponseId: z.string(),
      model: z.literal('gpt-6-astra'),
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
    });
    try {
      result = Receipt.parse(
        await provider.generate({
          model: 'gpt-6-astra',
          reasoningEffort: 'medium',
          maxOutputTokens: 4000,
          instructions: durableFinanceProposalInstructions,
          prompt: JSON.stringify({
            source: table,
            task: 'Propose a mapping of these synthetic source columns. Preserve the supplied providerKey and reportType. No approval or posting is authorized.',
          }),
          signal: AbortSignal.timeout(90000),
        }),
      );
    } catch (error) {
      if (error instanceof z.ZodError) {
        process.stdout.write(
          JSON.stringify({
            event: 'finance-live-schema-rejected',
            issues: error.issues.map((issue) => ({
              code: issue.code,
              path: issue.path.map((part) =>
                /^[A-Za-z0-9_-]{1,80}$/.test(String(part))
                  ? String(part)
                  : 'redacted',
              ),
            })),
          }) + '\n',
        );
      }
      // Never let SDK request headers, credentials or raw provider bodies enter CI logs.
      const status =
        error &&
        typeof error === 'object' &&
        'status' in error &&
        typeof error.status === 'number'
          ? error.status
          : 'unavailable';
      const name =
        error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,60}$/.test(error.name)
          ? error.name
          : 'unknown';
      const cause =
        error && typeof error === 'object' && 'cause' in error
          ? error.cause
          : undefined;
      const code =
        cause &&
        typeof cause === 'object' &&
        'code' in cause &&
        typeof cause.code === 'string' &&
        /^[A-Z_]{1,40}$/.test(cause.code)
          ? cause.code
          : 'unknown';
      throw new Error(
        `finance-live-provider-check-failed:${status}:${name}:${code}`,
      );
    }
    expect(result.providerResponseId).toMatch(/^resp_/);
    expect(result.inputTokens).toBeGreaterThan(0);
    expect(result.outputTokens).toBeGreaterThan(0);
    const normalized = normalizeExtractedReport(
      result.proposal.definition,
      table,
    );
    expect(normalized.status).toBe('normalized');
    expect(normalized.rows.map((row) => row.fields.amount)).toEqual([
      '123.45',
      '-67.89',
    ]);
    expect(normalized.rows.map((row) => row.fields.currency)).toEqual([
      'CAD',
      'CAD',
    ]);
    process.stdout.write(
      JSON.stringify({
        event: 'finance-live-provider-mapping-verified',
        providerResponseId: result.providerResponseId,
        model: result.model,
        reasoningEffort: 'medium',
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        sourceSha256: createHash('sha256').update(original).digest('hex'),
        normalizedRows: normalized.rows.length,
        approved: false,
        posted: false,
      }) + '\n',
    );
  },
  100000,
);
