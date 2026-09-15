import {
  Agent,
  Runner,
  ModelBehaviorError,
  type Model,
  type ModelProvider,
} from '@openai/agents';
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
    dateYear: mapping.dateYear.unwrap(),
    currencyCode: z.null(),
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

const SafeReceiptSchema = z.strictObject({
  providerResponseId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
  inputTokens: z.number().int().safe().nonnegative(),
  outputTokens: z.number().int().safe().nonnegative(),
});
type SafeReceipt = z.infer<typeof SafeReceiptSchema>;
export type FinanceProposalFailureCode =
  | 'provider-transport'
  | 'provider-incomplete-output'
  | 'provider-incomplete-output-max-output-tokens'
  | 'provider-incomplete-output-content-filter'
  | 'provider-structured-validation'
  | 'provider-canonical-validation'
  | 'provider-canonical-validation-required-fields-missing'
  | 'provider-canonical-validation-duplicate-field'
  | 'provider-canonical-validation-heading-absent'
  | 'provider-canonical-validation-bank-amount-bindings'
  | 'provider-receipt-missing';

/** Contains only fixed codes and validated billing metadata, never source/output
 * text, SDK errors, validation values, or raw response objects. */
export class FinanceProposalProviderFailure extends Error {
  readonly receipt?: Readonly<SafeReceipt>;
  constructor(
    readonly code: FinanceProposalFailureCode,
    receipt?: SafeReceipt,
  ) {
    super(code);
    this.name = 'FinanceProposalProviderFailure';
    this.receipt = receipt
      ? Object.freeze(SafeReceiptSchema.parse(receipt))
      : undefined;
  }
}

/** Shared production OpenAI provider must be configured with useResponses:true.
 * No session, tracing payload, tools, handoffs, or write ports are installed. */
export function createDurableFinanceProposalProvider(
  modelProvider: ModelProvider,
): DurableFinanceProposalProvider {
  return Object.freeze({
    async generate(
      input: Parameters<DurableFinanceProposalProvider['generate']>[0],
    ) {
      // Request-local capture precedes SDK JSON/Zod parsing, which can throw
      // before Runner returns. Never retain providerData or error causes.
      let receipt: SafeReceipt | undefined;
      let responseReceived = false;
      let calls = 0;
      const runner = new Runner({
        modelProvider: {
          async getModel(name) {
            const model = await modelProvider.getModel(name);
            return {
              async getResponse(request) {
                if (++calls !== 1)
                  throw new FinanceProposalProviderFailure(
                    'provider-receipt-missing',
                  );
                const response = await model.getResponse(request);
                responseReceived = true;
                const parsed = SafeReceiptSchema.safeParse({
                  providerResponseId: response.responseId,
                  inputTokens: response.usage.inputTokens,
                  outputTokens: response.usage.outputTokens,
                });
                receipt = parsed.success ? parsed.data : undefined;
                if (response.providerData?.status === 'incomplete') {
                  const reason: unknown =
                    response.providerData?.incomplete_details?.reason;
                  const code =
                    reason === 'max_output_tokens'
                      ? 'provider-incomplete-output-max-output-tokens'
                      : reason === 'content_filter'
                        ? 'provider-incomplete-output-content-filter'
                        : 'provider-incomplete-output';
                  throw new FinanceProposalProviderFailure(code, receipt);
                }
                return response;
              },
              getStreamedResponse() {
                throw new FinanceProposalProviderFailure('provider-transport');
              },
            } satisfies Model;
          },
        },
        tracingDisabled: true,
        traceIncludeSensitiveData: false,
      });
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
      let result;
      try {
        result = await runner.run(finance, input.prompt, {
          maxTurns: 1,
          signal: input.signal,
        });
      } catch (error) {
        if (error instanceof FinanceProposalProviderFailure) throw error;
        throw new FinanceProposalProviderFailure(
          error instanceof SyntaxError ||
            error instanceof z.ZodError ||
            (error instanceof ModelBehaviorError &&
              error.message.startsWith('Invalid output type:'))
            ? 'provider-structured-validation'
            : responseReceived
              ? 'provider-incomplete-output'
              : 'provider-transport',
          receipt,
        );
      }
      if (
        !receipt ||
        result.lastResponseId !== receipt.providerResponseId ||
        !result.finalOutput ||
        result.rawResponses.length !== 1
      )
        throw new FinanceProposalProviderFailure('provider-receipt-missing');
      const structured = ModelProposalSchema.safeParse(result.finalOutput);
      if (!structured.success)
        throw new FinanceProposalProviderFailure(
          'provider-structured-validation',
          receipt,
        );
      const canonical = ProposedFinanceReportMappingSchema.safeParse(
        structured.data,
      );
      if (!canonical.success) {
        const messages = canonical.error.issues.map((issue) => issue.message);
        const code = messages.includes('Required canonical fields are missing')
          ? 'provider-canonical-validation-required-fields-missing'
          : messages.includes('Map each canonical field once')
            ? 'provider-canonical-validation-duplicate-field'
            : messages.includes('Mapped source heading is absent')
              ? 'provider-canonical-validation-heading-absent'
              : messages.includes(
                    'Bank transactions require amount alone or both debit and credit',
                  )
                ? 'provider-canonical-validation-bank-amount-bindings'
                : 'provider-canonical-validation';
        throw new FinanceProposalProviderFailure(code, receipt);
      }
      return { proposal: canonical.data, ...receipt, model: input.model };
    },
  });
}
