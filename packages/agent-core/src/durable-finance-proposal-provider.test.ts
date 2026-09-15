import { Usage, type Model, type ModelResponse } from '@openai/agents';
import { describe, expect, it, vi } from 'vitest';
import { DURABLE_FINANCE_PROPOSAL_SCHEMA_BYTE_CEILING } from './durable-finance-standardization.js';
import { createDurableFinanceProposalProvider } from './durable-finance-proposal-provider.js';

const proposal = {
  definition: {
    providerKey: 'bank',
    reportName: 'Statement',
    reportType: 'bank-transactions',
    layoutVersion: '1',
    headers: ['Date', 'Description', 'Amount', 'Currency'],
    bindings: [
      { field: 'transactionDate', column: 'Date', context: null },
      { field: 'description', column: 'Description', context: null },
      { field: 'amount', column: 'Amount', context: null },
      { field: 'currency', column: 'Currency', context: null },
    ],
    dateFormat: 'yyyy-mm-dd',
    decimalSeparator: '.',
    groupingSeparator: '',
    quantityUnit: null,
    valuationMultiplier: null,
    identifierScheme: null,
    identifierNamespace: null,
  },
  rationale: 'Source columns are explicit.',
  unresolvedQuestions: [],
};
function fixture(output: unknown = proposal) {
  const getResponse = vi.fn<Model['getResponse']>(
    async () =>
      ({
        responseId: 'resp_sdk_verified',
        usage: new Usage({ inputTokens: 123, outputTokens: 45, requests: 1 }),
        output: [
          {
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: JSON.stringify(output) }],
          },
        ],
      }) satisfies ModelResponse,
  );
  const model: Model = {
    getResponse,
    getStreamedResponse() {
      throw new Error('streaming-not-enabled');
    },
  };
  const getModel = vi.fn(() => model);
  return {
    getResponse,
    getModel,
    provider: createDurableFinanceProposalProvider({ getModel }),
  };
}
describe('durable Finance SDK provider', () => {
  it('executes exactly one tool-free Astra request with medium reasoning and actual usage', async () => {
    const f = fixture();
    expect(
      await f.provider.generate({
        instructions: 'Propose only.',
        prompt: 'Source facts.',
        model: 'gpt-6-astra',
        reasoningEffort: 'medium',
        maxOutputTokens: 4000,
        signal: new AbortController().signal,
      }),
    ).toMatchObject({
      proposal,
      providerResponseId: 'resp_sdk_verified',
      inputTokens: 123,
      outputTokens: 45,
      model: 'gpt-6-astra',
    });
    expect(f.getResponse).toHaveBeenCalledTimes(1);
    expect(f.getModel).toHaveBeenCalledWith('gpt-6-astra');
    expect(f.getResponse.mock.calls[0]?.[0]).toMatchObject({
      tools: [],
      handoffs: [],
      modelSettings: {
        reasoning: { effort: 'medium' },
        maxTokens: 4000,
        store: false,
        retry: { maxRetries: 0 },
      },
    });
  });
  it('sends a strict structured proposal schema with required rationale and no review authority fields', async () => {
    const f = fixture();
    await f.provider.generate({
      instructions: 'Propose only.',
      prompt: 'Source facts.',
      model: 'gpt-6-astra',
      reasoningEffort: 'medium',
      maxOutputTokens: 4000,
      signal: new AbortController().signal,
    });
    const output = f.getResponse.mock.calls[0]![0].outputType;
    expect(output).toMatchObject({ type: 'json_schema', strict: true });
    if (output === 'text' || output.type !== 'json_schema')
      throw new Error('structured-output-required');
    expect(
      Buffer.byteLength(JSON.stringify(output), 'utf8'),
    ).toBeLessThanOrEqual(DURABLE_FINANCE_PROPOSAL_SCHEMA_BYTE_CEILING);
    const schema = output.schema as unknown as {
      properties: Record<string, { properties: Record<string, unknown> }>;
    };
    expect(Object.keys(schema.properties).sort()).toEqual([
      'definition',
      'rationale',
      'unresolvedQuestions',
    ]);
    expect(schema.properties.rationale).toMatchObject({
      type: 'string',
      minLength: 1,
      maxLength: 3000,
    });
    expect(Object.keys(schema.properties.definition.properties).sort()).toEqual(
      Object.keys(proposal.definition).sort(),
    );
    for (const name of [
      'xlsxSelection',
      'pdfSelection',
      'imageSelection',
      'pdfOcrSelection',
      'proposalJson',
    ]) {
      expect(JSON.stringify(schema)).not.toContain(name);
    }
    const check = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) {
        value.forEach(check);
        return;
      }
      const node = value as Record<string, unknown>;
      if (node.type === 'object') {
        expect(node.additionalProperties).toBe(false);
        expect(new Set(node.required as string[])).toEqual(
          new Set(Object.keys(node.properties as object)),
        );
      }
      Object.values(node).forEach(check);
    };
    check(schema);
  });

  it.each([
    ['missing rationale', { ...proposal, rationale: undefined }],
    ['null rationale', { ...proposal, rationale: null }],
    [
      'object rationale',
      { ...proposal, rationale: { explanation: 'Source facts' } },
    ],
    ['empty rationale', { ...proposal, rationale: '' }],
    [
      'missing nullable field',
      {
        ...proposal,
        definition: { ...proposal.definition, quantityUnit: undefined },
      },
    ],
    ['old string wrapper', { proposalJson: JSON.stringify(proposal) }],
    ...[
      'xlsxSelection',
      'pdfSelection',
      'imageSelection',
      'pdfOcrSelection',
    ].flatMap((name): [string, unknown][] => [
      [
        name,
        {
          ...proposal,
          definition: { ...proposal.definition, [name]: { reviewed: true } },
        },
      ],
      [
        `${name} null`,
        { ...proposal, definition: { ...proposal.definition, [name]: null } },
      ],
    ]),
    [
      'canonical cross-field violation',
      {
        ...proposal,
        definition: { ...proposal.definition, groupingSeparator: '.' },
      },
    ],
  ] as [string, unknown][])(
    'rejects %s without another model call',
    async (_name, invalid) => {
      const f = fixture(invalid);
      await expect(
        f.provider.generate({
          instructions: 'Propose only.',
          prompt: 'Source facts.',
          model: 'gpt-6-astra',
          reasoningEffort: 'medium',
          maxOutputTokens: 4000,
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow();
      expect(f.getResponse).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects invalid model-authored proposals without a second model call', async () => {
    const f = fixture({ approve: true });
    await expect(
      f.provider.generate({
        instructions: 'Propose only.',
        prompt: 'Source facts.',
        model: 'gpt-6-astra',
        reasoningEffort: 'medium',
        maxOutputTokens: 4000,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow();
    expect(f.getResponse).toHaveBeenCalledTimes(1);
  });
});
