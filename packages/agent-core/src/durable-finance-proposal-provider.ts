import { Agent, Runner, type ModelProvider } from '@openai/agents';
import {
  FinanceReportMappingDefinitionSchema,
  ProposedFinanceReportMappingSchema,
} from '@emdo/contracts';
import { z } from 'zod';
import type { DurableFinanceProposalProvider } from './durable-finance-standardization.js';

// Allowlist only mapping data; human-reviewed selections never belong to model output.
// Reuse canonical field constraints without the cross-field refinements that cannot
// be expressed by the provider JSON Schema. The full canonical parse runs afterward.
const mapping = FinanceReportMappingDefinitionSchema.shape;
const ModelProposalSchema = z.strictObject({
  definition: z.strictObject({
    providerKey: mapping.providerKey,
    reportName: mapping.reportName,
    reportType: mapping.reportType,
    layoutVersion: mapping.layoutVersion,
    headers: mapping.headers,
    bindings: mapping.bindings,
    dateFormat: mapping.dateFormat,
    decimalSeparator: mapping.decimalSeparator,
    groupingSeparator: mapping.groupingSeparator,
    quantityUnit: mapping.quantityUnit,
    valuationMultiplier: mapping.valuationMultiplier,
    identifierScheme: mapping.identifierScheme,
    identifierNamespace: mapping.identifierNamespace,
  }),
  rationale: ProposedFinanceReportMappingSchema.shape.rationale,
  unresolvedQuestions:
    ProposedFinanceReportMappingSchema.shape.unresolvedQuestions,
});

/** Shared production OpenAI provider must be configured with useResponses:true.
 * No session, tracing payload, tools, handoffs, or write ports are installed. */
export function createDurableFinanceProposalProvider(
  modelProvider: ModelProvider,
): DurableFinanceProposalProvider {
  const runner = new Runner({
    modelProvider,
    tracingDisabled: true,
    traceIncludeSensitiveData: false,
  });
  return Object.freeze({
    async generate(
      input: Parameters<DurableFinanceProposalProvider['generate']>[0],
    ) {
      const finance = new Agent({
        name: 'Finance report standardization',
        instructions: input.instructions,
        model: input.model,
        modelSettings: {
          reasoning: { effort: 'medium' },
          maxTokens: input.maxOutputTokens,
          store: false,
          retry: { maxRetries: 0 },
        },
        outputType: ModelProposalSchema,
        tools: [],
        handoffs: [],
      });
      const result = await runner.run(finance, input.prompt, {
        maxTurns: 1,
        signal: input.signal,
      });
      if (
        !result.lastResponseId ||
        !result.finalOutput ||
        result.rawResponses.length !== 1
      )
        throw new Error('finance-standardization-provider-receipt-missing');
      const usage = result.rawResponses[0]!.usage;
      return {
        proposal: ProposedFinanceReportMappingSchema.parse(
          ModelProposalSchema.parse(result.finalOutput),
        ),
        providerResponseId: result.lastResponseId,
        model: input.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      };
    },
  });
}
