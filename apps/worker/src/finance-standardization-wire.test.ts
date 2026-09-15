import OpenAI from 'openai';
import { OpenAIProvider } from '@openai/agents';
import {
  createDurableFinanceProposalProvider,
  FinanceProposalProviderFailure,
} from '@emdo/agent-core';
import { expect, it, vi } from 'vitest';

it('serializes the production Astra proposal through Responses without unsupported parameters or write tools', async () => {
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
    rationale: 'Explicit source columns.',
    unresolvedQuestions: [],
  };
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return new Response(
      JSON.stringify({
        id: 'resp_standardization_wire',
        object: 'response',
        created_at: 1,
        status: 'completed',
        model: 'gpt-6-astra',
        error: null,
        incomplete_details: null,
        output: [
          {
            type: 'message',
            id: 'msg_wire',
            status: 'completed',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text: JSON.stringify(proposal),
                annotations: [],
              },
            ],
          },
        ],
        usage: {
          input_tokens: 123,
          output_tokens: 45,
          total_tokens: 168,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      }),
      { headers: { 'content-type': 'application/json' } },
    );
  });
  const client = new OpenAI({
    apiKey: 'synthetic-not-a-real-key',
    baseURL: 'https://sdk-test.invalid/v1',
    fetch: fetcher,
    maxRetries: 0,
  });
  const provider = createDurableFinanceProposalProvider(
    new OpenAIProvider({
      openAIClient: client,
      useResponses: true,
      useResponsesWebSocket: false,
    }),
  );
  const result = await provider.generate({
    model: 'gpt-6-astra',
    reasoningEffort: 'medium',
    instructions: 'Propose mappings only.',
    prompt: 'Synthetic source columns.',
    maxOutputTokens: 4000,
    signal: new AbortController().signal,
  });
  expect(result).toMatchObject({
    proposal,
    providerResponseId: 'resp_standardization_wire',
    inputTokens: 123,
    outputTokens: 45,
  });
  expect(requests).toHaveLength(1);
  expect(requests[0]!.url).toBe('https://sdk-test.invalid/v1/responses');
  expect(requests[0]!.body).toMatchObject({
    model: 'gpt-6-astra',
    reasoning: { effort: 'medium' },
    max_output_tokens: 4000,
    store: false,
    text: {
      format: {
        type: 'json_schema',
        strict: true,
        schema: {
          type: 'object',
          required: ['definition', 'rationale', 'unresolvedQuestions'],
          additionalProperties: false,
        },
      },
    },
  });
  expect(requests[0]!.body.tools ?? []).toEqual([]);
  for (const key of [
    'temperature',
    'top_p',
    'top_logprobs',
    'logprobs',
    'prompt_cache_retention',
  ])
    expect(requests[0]!.body).not.toHaveProperty(key);
  expect(requests[0]!.body).not.toHaveProperty('previous_response_id');
});

it('captures incomplete Responses billing metadata before partial output parsing without leaking response content', async () => {
  const fetcher = vi.fn<typeof fetch>(
    async () =>
      new Response(
        JSON.stringify({
          id: 'resp_wire_incomplete',
          object: 'response',
          created_at: 1,
          status: 'incomplete',
          model: 'gpt-6-astra',
          error: null,
          incomplete_details: { reason: 'max_output_tokens' },
          output: [
            {
              type: 'message',
              id: 'msg_partial',
              status: 'incomplete',
              role: 'assistant',
              content: [
                {
                  type: 'output_text',
                  text: '{"PRIVATE_OUTPUT_SENTINEL":',
                  annotations: [],
                },
              ],
            },
          ],
          usage: {
            input_tokens: 2500,
            output_tokens: 4000,
            total_tokens: 6500,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 3500 },
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
  );
  const client = new OpenAI({
    apiKey: 'synthetic-not-a-real-key',
    baseURL: 'https://sdk-test.invalid/v1',
    fetch: fetcher,
    maxRetries: 0,
  });
  const provider = createDurableFinanceProposalProvider(
    new OpenAIProvider({
      openAIClient: client,
      useResponses: true,
      useResponsesWebSocket: false,
    }),
  );
  const error = await provider
    .generate({
      model: 'gpt-6-astra',
      reasoningEffort: 'medium',
      instructions: 'Propose mappings only.',
      prompt: 'PRIVATE_SOURCE_SENTINEL',
      maxOutputTokens: 4000,
      signal: new AbortController().signal,
    })
    .catch((error: unknown) => error);
  if (!(error instanceof FinanceProposalProviderFailure))
    throw new Error('expected-safe-provider-failure');
  expect(error.code).toBe('provider-incomplete-output-max-output-tokens');
  expect(error.receipt).toEqual({
    providerResponseId: 'resp_wire_incomplete',
    inputTokens: 2500,
    outputTokens: 4000,
  });
  expect(error.cause).toBeUndefined();
  expect(JSON.stringify(error)).not.toContain('PRIVATE_');
  expect(fetcher).toHaveBeenCalledTimes(1);
});
