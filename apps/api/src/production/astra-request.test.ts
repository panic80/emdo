import { setOpenAIAPI, tool } from '@openai/agents';
import { createOpenAiAgentsSdkFacade } from '@emdo/agent-core';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createProductionOpenAiAgentServiceBundle } from './core-openai-services.js';

it('sends Astra tools through Responses with supported reasoning and privacy settings', async () => {
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  const execute = vi.fn(async () => 'record');
  const fetch = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(
        JSON.stringify({
          id: 'resp_astra_contract',
          object: 'response',
          created_at: 1,
          status: 'completed',
          model: 'gpt-6-astra',
          output:
            requests.length === 1
              ? [
                  {
                    id: 'fc_astra_contract',
                    type: 'function_call',
                    call_id: 'call_read_record',
                    name: 'read_record',
                    arguments: '{"id":"fixture"}',
                    status: 'completed',
                  },
                ]
              : [
                  {
                    id: 'msg_astra_contract',
                    type: 'message',
                    role: 'assistant',
                    status: 'completed',
                    content: [
                      {
                        type: 'output_text',
                        text: '{"message":"Ready"}',
                        annotations: [],
                      },
                    ],
                  },
                ],
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            total_tokens: 15,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 1 },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  );
  vi.stubGlobal('fetch', fetch);
  // Production must not inherit another SDK consumer's Chat Completions default.
  setOpenAIAPI('chat_completions');
  const bundle = createProductionOpenAiAgentServiceBundle({
    environment: {
      EMDO_OPENAI_AGENT_API_KEY: `sk-proj-${'a'.repeat(40)}`,
      EMDO_OPENAI_AGENT_PRICING_VERSION: 'astra-test-rates',
      EMDO_OPENAI_AGENT_GPT_6_ASTRA_INPUT_CAD_MINOR_PER_MILLION_TOKENS: '100',
      EMDO_OPENAI_AGENT_GPT_6_ASTRA_OUTPUT_CAD_MINOR_PER_MILLION_TOKENS: '200',
    },
  });
  try {
    if (bundle === undefined) throw new Error('test-bundle-unavailable');
    const agent = createOpenAiAgentsSdkFacade().createAgent({
      name: 'astra-contract',
      instructions: 'Return a brief JSON message.',
      model: 'gpt-6-astra',
      maxOutputTokens: 1_000,
      outputType: z.strictObject({ message: z.string() }),
      tools: [
        tool({
          name: 'read_record',
          description: 'Read a test record.',
          parameters: z.strictObject({ id: z.string() }),
          execute,
        }),
      ],
    });
    await bundle.runner.run(agent, 'Check the configuration.', {
      maxTurns: 3,
      signal: new AbortController().signal,
      toolNameCollisionPolicy: 'error',
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.url).toBe('https://api.openai.com/v1/responses');
      expect(request.body).toMatchObject({
        model: 'gpt-6-astra',
        reasoning: { effort: 'medium' },
        store: false,
        service_tier: 'default',
        prompt_cache_options: { ttl: '30m' },
        max_output_tokens: 1_000,
        tools: [
          expect.objectContaining({ type: 'function', name: 'read_record' }),
        ],
        text: { format: { type: 'json_schema', strict: true } },
      });
      for (const key of [
        'temperature',
        'top_p',
        'top_logprobs',
        'logprobs',
        'prompt_cache_retention',
      ]) {
        expect(request.body).not.toHaveProperty(key);
      }
      expect(request.body.include ?? []).not.toContain(
        'message.output_text.logprobs',
      );
    }
  } finally {
    await bundle?.close();
    setOpenAIAPI('responses');
    vi.unstubAllGlobals();
  }
});
