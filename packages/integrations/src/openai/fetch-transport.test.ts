import { describe, expect, it } from 'vitest';

import {
  OPENAI_AUDIO_LIMITS,
  OpenAiAudioTransportError,
  OpenAiFetchAudioTransport,
  type OpenAiFetch,
} from './index.js';

const apiKey = `sk-proj-${'a'.repeat(32)}`;

describe('OpenAiFetchAudioTransport', () => {
  it('sends bounded multipart transcription requests to the documented endpoint', async () => {
    const fetch: OpenAiFetch = async (input, init) => {
      expect(input).toBe('https://api.openai.com/v1/audio/transcriptions');
      expect(init?.method).toBe('POST');
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe(`Bearer ${apiKey}`);
      expect(headers.has('content-type')).toBe(false);
      const form = init?.body as FormData;
      expect(form.get('model')).toBe('gpt-4o-mini-transcribe');
      expect(form.get('response_format')).toBe('json');
      expect(form.get('language')).toBe('en');
      const file = form.get('file');
      expect(file).toBeInstanceOf(Blob);
      expect((file as File).name).toBe('voice.webm');
      expect([...new Uint8Array(await (file as Blob).arrayBuffer())]).toEqual([
        1, 2, 3,
      ]);
      return new Response(
        JSON.stringify({
          text: 'Hello world',
          usage: {
            type: 'tokens',
            input_tokens: 2,
            output_tokens: 2,
            total_tokens: 4,
          },
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'x-request-id': 'req_transcribe_fetch',
          },
        },
      );
    };
    const transport = new OpenAiFetchAudioTransport({
      fetch,
      getApiKey: async () => apiKey,
    });

    await expect(
      transport.transcribe({
        model: 'gpt-4o-mini-transcribe',
        audio: new Uint8Array([1, 2, 3]),
        mimeType: 'audio/webm',
        fileName: 'voice.webm',
        language: 'en',
        responseFormat: 'json',
        signal: new AbortController().signal,
        onDispatch: async () => undefined,
      }),
    ).resolves.toEqual({
      body: {
        text: 'Hello world',
        usage: {
          type: 'tokens',
          input_tokens: 2,
          output_tokens: 2,
          total_tokens: 4,
        },
      },
      providerRequestId: 'req_transcribe_fetch',
    });
  });

  it('sends speech JSON to the documented endpoint and returns bounded audio', async () => {
    const fetch: OpenAiFetch = async (input, init) => {
      expect(input).toBe('https://api.openai.com/v1/audio/speech');
      expect(init?.method).toBe('POST');
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe(`Bearer ${apiKey}`);
      expect(headers.get('content-type')).toBe('application/json');
      expect(JSON.parse(String(init?.body))).toEqual({
        model: 'gpt-4o-mini-tts',
        input: 'Household update',
        voice: 'alloy',
        response_format: 'mp3',
      });
      return new Response(new Uint8Array([4, 3, 2, 1]), {
        status: 200,
        headers: {
          'content-type': 'audio/mpeg',
          'x-request-id': 'req_speech_fetch',
        },
      });
    };
    const transport = new OpenAiFetchAudioTransport({
      fetch,
      getApiKey: () => apiKey,
    });

    const response = await transport.createSpeech({
      model: 'gpt-4o-mini-tts',
      input: 'Household update',
      voice: 'alloy',
      responseFormat: 'mp3',
      signal: new AbortController().signal,
      onDispatch: async () => undefined,
    });

    expect(response).toMatchObject({
      contentType: 'audio/mpeg',
      providerRequestId: 'req_speech_fetch',
    });
    expect([...response.audio]).toEqual([4, 3, 2, 1]);
  });

  it('does not include provider bodies, keys, or request payloads in failures', async () => {
    const fetch: OpenAiFetch = async () =>
      new Response(
        JSON.stringify({
          error: {
            message: `${apiKey} raw transcript household medical detail`,
          },
        }),
        {
          status: 400,
          headers: { 'x-request-id': 'req_safe_failure' },
        },
      );
    const transport = new OpenAiFetchAudioTransport({
      fetch,
      getApiKey: () => apiKey,
    });

    const failure = await transport
      .createSpeech({
        model: 'gpt-4o-mini-tts',
        input: 'household medical detail',
        voice: 'alloy',
        responseFormat: 'mp3',
        signal: new AbortController().signal,
        onDispatch: async () => undefined,
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(OpenAiAudioTransportError);
    expect(failure).toMatchObject({
      kind: 'provider-rejected',
      httpStatus: 400,
      retryable: false,
      providerRequestId: 'req_safe_failure',
    });
    expect(String(failure)).not.toContain(apiKey);
    expect(String(failure)).not.toContain('medical detail');
  });

  it('rejects oversized response bodies before buffering them', async () => {
    const fetch: OpenAiFetch = async () =>
      new Response(new Uint8Array([1]), {
        status: 200,
        headers: {
          'content-type': 'audio/mpeg',
          'content-length': String(OPENAI_AUDIO_LIMITS.maxSpeechBytes + 1),
        },
      });
    const transport = new OpenAiFetchAudioTransport({
      fetch,
      getApiKey: () => apiKey,
    });

    await expect(
      transport.createSpeech({
        model: 'gpt-4o-mini-tts',
        input: 'summary',
        voice: 'alloy',
        responseFormat: 'mp3',
        signal: new AbortController().signal,
        onDispatch: async () => undefined,
      }),
    ).rejects.toMatchObject({ kind: 'response-too-large' });
  });

  it('provides a no-run model availability transport contract', async () => {
    const seen: string[] = [];
    const fetch: OpenAiFetch = async (input, init) => {
      seen.push(String(input));
      expect(init?.method).toBe('GET');
      return new Response(JSON.stringify({ id: 'gpt-4o-mini-tts' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const transport = new OpenAiFetchAudioTransport({
      fetch,
      getApiKey: () => apiKey,
    });

    await expect(
      transport.checkModel('gpt-4o-mini-tts', new AbortController().signal),
    ).resolves.toEqual({
      status: 'available',
      resolvedModel: 'gpt-4o-mini-tts',
    });
    expect(seen).toEqual(['https://api.openai.com/v1/models/gpt-4o-mini-tts']);
  });

  it('stops waiting for a credential provider that ignores cancellation', async () => {
    const controller = new AbortController();
    let fetchCalls = 0;
    const transport = new OpenAiFetchAudioTransport({
      fetch: async () => {
        fetchCalls += 1;
        return new Response();
      },
      getApiKey: async () => new Promise<string>(() => undefined),
    });

    const pending = transport.checkModel('tts-1', controller.signal);
    controller.abort();
    const result = await Promise.race([
      pending.catch((error: unknown) => error),
      new Promise<'did-not-settle'>((resolve) =>
        setTimeout(() => resolve('did-not-settle'), 100),
      ),
    ]);

    expect(result).not.toBe('did-not-settle');
    expect(result).toMatchObject({ kind: 'request-aborted' });
    expect(fetchCalls).toBe(0);
  });

  it('stops waiting for a fetch implementation that ignores cancellation', async () => {
    const controller = new AbortController();
    let signalDispatched!: () => void;
    const dispatched = new Promise<void>((resolve) => {
      signalDispatched = resolve;
    });
    const transport = new OpenAiFetchAudioTransport({
      fetch: async () => new Promise<Response>(() => undefined),
      getApiKey: () => apiKey,
    });

    const pending = transport.createSpeech({
      model: 'tts-1',
      input: 'Bounded summary',
      voice: 'alloy',
      responseFormat: 'mp3',
      signal: controller.signal,
      onDispatch: async () => signalDispatched(),
    });
    await dispatched;
    controller.abort();
    const result = await Promise.race([
      pending.catch((error: unknown) => error),
      new Promise<'did-not-settle'>((resolve) =>
        setTimeout(() => resolve('did-not-settle'), 100),
      ),
    ]);

    expect(result).not.toBe('did-not-settle');
    expect(result).toMatchObject({ kind: 'request-aborted' });
  });

  it('cancels a provider response that arrives only after caller abort', async () => {
    const controller = new AbortController();
    let resolveFetch!: (response: Response) => void;
    let signalFetchStarted!: () => void;
    const delayedFetch = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const fetchStarted = new Promise<void>((resolve) => {
      signalFetchStarted = resolve;
    });
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { 'content-type': 'audio/mpeg' } },
    );
    const transport = new OpenAiFetchAudioTransport({
      fetch: async () => {
        signalFetchStarted();
        return delayedFetch;
      },
      getApiKey: () => apiKey,
    });
    const pending = transport.createSpeech({
      model: 'tts-1',
      input: 'Bounded summary',
      voice: 'alloy',
      responseFormat: 'mp3',
      signal: controller.signal,
      onDispatch: async () => undefined,
    });

    await fetchStarted;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ kind: 'request-aborted' });
    resolveFetch(response);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(cancelled).toBe(true);
  });

  it('zeroes buffered response bytes when a later body read is aborted', async () => {
    const controller = new AbortController();
    let signalPendingRead!: () => void;
    const pendingRead = new Promise<void>((resolve) => {
      signalPendingRead = resolve;
    });
    const bufferedChunk = new Uint8Array([7, 7, 7]);
    let pullCount = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(streamController) {
        pullCount += 1;
        if (pullCount === 1) {
          streamController.enqueue(bufferedChunk);
          return;
        }
        signalPendingRead();
        return new Promise<void>(() => undefined);
      },
    });
    const transport = new OpenAiFetchAudioTransport({
      fetch: async () =>
        new Response(stream, {
          headers: { 'content-type': 'audio/mpeg' },
        }),
      getApiKey: () => apiKey,
    });
    const pending = transport.createSpeech({
      model: 'tts-1',
      input: 'Bounded summary',
      voice: 'alloy',
      responseFormat: 'mp3',
      signal: controller.signal,
      onDispatch: async () => undefined,
    });
    await pendingRead;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ kind: 'request-aborted' });

    expect([...bufferedChunk]).toEqual([0, 0, 0]);
  });
});
