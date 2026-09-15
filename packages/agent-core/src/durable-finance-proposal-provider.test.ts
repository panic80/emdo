import { Usage, type Model, type ModelResponse } from '@openai/agents';
import { describe, expect, it, vi } from 'vitest';
import { DURABLE_FINANCE_PROPOSAL_SCHEMA_BYTE_CEILING } from './durable-finance-standardization.js';
import {
  createDurableFinanceProposalProvider,
  FinanceProposalProviderFailure,
} from './durable-finance-proposal-provider.js';

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
    dateYear: null,
    currencyCode: null,
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

const request = () => ({
  instructions: 'Propose only.',
  prompt: 'PRIVATE_SOURCE_SENTINEL',
  model: 'gpt-6-astra' as const,
  reasoningEffort: 'medium' as const,
  maxOutputTokens: 4000,
  signal: new AbortController().signal,
});

it.each([
  [
    'required-fields-missing',
    {
      ...proposal.definition,
      bindings: proposal.definition.bindings.filter(
        (b) => b.field !== 'description',
      ),
    },
  ],
  [
    'duplicate-field',
    {
      ...proposal.definition,
      bindings: [
        ...proposal.definition.bindings,
        { field: 'amount', column: 'Debit', context: null },
      ],
      headers: [...proposal.definition.headers, 'Debit'],
    },
  ],
  [
    'heading-absent',
    {
      ...proposal.definition,
      bindings: proposal.definition.bindings.map((b) =>
        b.field === 'amount' ? { ...b, column: 'PRIVATE_OUTPUT_SENTINEL' } : b,
      ),
    },
  ],
] as const)(
  'retains billing metadata with safe canonical code %s',
  async (suffix, definition) => {
    const f = fixture({ ...proposal, definition });
    const error = await f.provider
      .generate(request())
      .catch((error: unknown) => error);
    if (!(error instanceof FinanceProposalProviderFailure))
      throw new Error('expected-sanitized-provider-failure');
    expect(error).toBeInstanceOf(FinanceProposalProviderFailure);
    expect(error.code).toBe(`provider-canonical-validation-${suffix}`);
    expect(error.receipt).toEqual({
      providerResponseId: 'resp_sdk_verified',
      inputTokens: 123,
      outputTokens: 45,
    });
    expect(JSON.stringify(error)).not.toMatch(
      /PRIVATE_|Source columns|Date|bindings/,
    );
    expect(error.cause).toBeUndefined();
    expect(f.getResponse).toHaveBeenCalledTimes(1);
  },
);

it('captures receipt before SDK structured validation failure without leaking rejected data', async () => {
  const f = fixture({
    ...proposal,
    rationale: { PRIVATE_OUTPUT_SENTINEL: 'secret' },
  });
  const error = await f.provider
    .generate(request())
    .catch((error: unknown) => error);
  if (!(error instanceof FinanceProposalProviderFailure))
    throw new Error('expected-sanitized-provider-failure');
  expect(error).toMatchObject({
    code: 'provider-structured-validation',
    receipt: { inputTokens: 123, outputTokens: 45 },
  });
  expect(JSON.stringify(error)).not.toContain('PRIVATE_');
  expect(f.getResponse).toHaveBeenCalledTimes(1);
});

it('distinguishes incomplete output before parsing partial JSON and keeps only allowlisted metadata', async () => {
  const f = fixture();
  f.getResponse.mockResolvedValueOnce({
    responseId: 'resp_incomplete',
    usage: new Usage({ inputTokens: 111, outputTokens: 4000 }),
    output: [
      {
        type: 'message',
        role: 'assistant',
        status: 'incomplete',
        content: [{ type: 'output_text', text: '{PRIVATE_OUTPUT_SENTINEL' }],
      },
    ],
    providerData: {
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      secret: 'PRIVATE_SOURCE_SENTINEL',
    },
  });
  const error = await f.provider
    .generate(request())
    .catch((error: unknown) => error);
  if (!(error instanceof FinanceProposalProviderFailure))
    throw new Error('expected-sanitized-provider-failure');
  expect(error).toMatchObject({
    code: 'provider-incomplete-output-max-output-tokens',
    receipt: {
      providerResponseId: 'resp_incomplete',
      inputTokens: 111,
      outputTokens: 4000,
    },
  });
  expect(JSON.stringify(error)).not.toContain('PRIVATE_');
  expect(f.getResponse).toHaveBeenCalledTimes(1);
});

it('sanitizes transport failures and does not invent a receipt', async () => {
  const f = fixture();
  f.getResponse.mockRejectedValueOnce(new Error('PRIVATE_SOURCE_SENTINEL'));
  const error = await f.provider
    .generate(request())
    .catch((error: unknown) => error);
  if (!(error instanceof FinanceProposalProviderFailure))
    throw new Error('expected-sanitized-provider-failure');
  expect(error).toMatchObject({ code: 'provider-transport' });
  expect(error.receipt).toBeUndefined();
  expect(error.cause).toBeUndefined();
  expect(JSON.stringify(error)).not.toContain('PRIVATE_');
  expect(f.getResponse).toHaveBeenCalledTimes(1);
});

it('does not carry a previous request receipt into a later transport failure', async () => {
  const f = fixture();
  await f.provider.generate(request());
  f.getResponse.mockRejectedValueOnce(new Error('PRIVATE_SOURCE_SENTINEL'));
  const error = await f.provider
    .generate(request())
    .catch((error: unknown) => error);
  if (!(error instanceof FinanceProposalProviderFailure))
    throw new Error('expected-sanitized-provider-failure');
  expect(error).toMatchObject({ code: 'provider-transport' });
  expect(error.receipt).toBeUndefined();
  expect(f.getResponse).toHaveBeenCalledTimes(2);
});

it('maps unknown incomplete details to a fixed code without copying them', async () => {
  const f = fixture();
  f.getResponse.mockResolvedValueOnce({
    responseId: 'resp_unknown_incomplete',
    usage: new Usage({ inputTokens: 1, outputTokens: 2 }),
    output: [],
    providerData: {
      status: 'incomplete',
      incomplete_details: { reason: 'PRIVATE_OUTPUT_SENTINEL' },
    },
  });
  const error = await f.provider
    .generate(request())
    .catch((error: unknown) => error);
  if (!(error instanceof FinanceProposalProviderFailure))
    throw new Error('expected-sanitized-provider-failure');
  expect(error.code).toBe('provider-incomplete-output');
  expect(JSON.stringify(error)).not.toContain('PRIVATE_');
});

it('includes required nullable dateYear and supports explicit bank debit/credit mappings', async () => {
  const f = fixture({
    ...proposal,
    definition: {
      ...proposal.definition,
      dateFormat: 'mmm dd',
      dateYear: 2026,
      headers: ['Date', 'Description', 'Debit', 'Credit', 'Currency'],
      bindings: [
        ...proposal.definition.bindings.filter(
          (binding) => binding.field !== 'amount',
        ),
        { field: 'debit', column: 'Debit', context: null },
        { field: 'credit', column: 'Credit', context: null },
      ],
    },
  });
  expect(await f.provider.generate(request())).toMatchObject({
    proposal: { definition: { dateFormat: 'mmm dd', dateYear: 2026 } },
  });
  expect(f.getResponse).toHaveBeenCalledTimes(1);
});

it('rejects model-selected account currency', async () => {
  const f = fixture({
    ...proposal,
    definition: { ...proposal.definition, currencyCode: 'CAD' },
  });
  const error = await f.provider
    .generate(request())
    .catch((error: unknown) => error);
  expect(error).toMatchObject({ code: 'provider-structured-validation' });
  expect(f.getResponse).toHaveBeenCalledTimes(1);
});
