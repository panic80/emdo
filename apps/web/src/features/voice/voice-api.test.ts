import { describe, expect, it, vi } from 'vitest';

import { VoiceApiError, speakSummary, transcribeVoice } from './voice-api.js';

const safeHeaders = {
  'cache-control': 'no-store, private',
  pragma: 'no-cache',
  expires: '0',
  'x-content-type-options': 'nosniff',
};

function transcriptionResponse(
  overrides: Readonly<Record<string, unknown>> = {},
): Response {
  return new Response(
    JSON.stringify({
      schemaVersion: 1,
      transcript: 'Book the dentist.',
      model: 'gpt-4o-mini-transcribe',
      attempt: 'default',
      spendWarning: false,
      replayed: false,
      ...overrides,
    }),
    {
      status: 200,
      headers: { ...safeHeaders, 'content-type': 'application/json' },
    },
  );
}

describe('voice API client', () => {
  it('posts the recording as the raw audio body with duration and attempt in the query', async () => {
    const fetcher = vi.fn(async () => transcriptionResponse());
    const audio = new Blob(['audio bytes'], { type: 'audio/webm' });

    const result = await transcribeVoice(
      {
        audio,
        durationMs: 8_500,
        attempt: 'default',
        csrfToken: 'csrf-1',
        idempotencyKey: 'voice-1',
      },
      { fetcher },
    );

    expect(result).toEqual({
      schemaVersion: 1,
      transcript: 'Book the dentist.',
      model: 'gpt-4o-mini-transcribe',
      attempt: 'default',
      spendWarning: false,
      replayed: false,
    });
    const [url, init] = fetcher.mock.calls[0]! as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      '/api/v1/voice/transcribe?durationMs=8500&attempt=default',
    );
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      body: audio,
    });
    expect(init.headers).toEqual({
      accept: 'application/json',
      'content-type': 'audio/webm',
      'idempotency-key': 'voice-1',
      'x-csrf-token': 'csrf-1',
    });
    expect(init.headers).not.toHaveProperty('origin');
    expect(init.body).not.toBeInstanceOf(FormData);
  });

  it('uses the accuracy retry without changing the audio body or selecting a model', async () => {
    const fetcher = vi.fn(async () =>
      transcriptionResponse({
        transcript: 'Accurate text',
        model: 'gpt-4o-transcribe',
        attempt: 'accuracy-retry',
      }),
    );
    const audio = new Blob(['same audio'], { type: 'audio/webm;codecs=opus' });

    await transcribeVoice(
      {
        audio,
        durationMs: 10_000,
        attempt: 'accuracy-retry',
        csrfToken: 'csrf-2',
        idempotencyKey: 'voice-2',
      },
      { fetcher },
    );

    const [url, init] = fetcher.mock.calls[0]! as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      '/api/v1/voice/transcribe?durationMs=10000&attempt=accuracy-retry',
    );
    expect(init.body).toBe(audio);
    expect(init.headers).toMatchObject({
      'content-type': 'audio/webm;codecs=opus',
    });
    expect(url).not.toContain('model');
    expect(JSON.stringify(init)).not.toContain('gpt-4o-transcribe');
  });

  it.each([
    'audio/mpeg',
    'audio/mp4',
    'audio/ogg',
    'audio/wav',
    'audio/webm',
    'audio/x-wav',
  ])('accepts the supported %s recording content type', async (contentType) => {
    const fetcher = vi.fn(async () => transcriptionResponse());

    await transcribeVoice(
      {
        audio: new Blob(['audio'], { type: contentType }),
        durationMs: 1,
        attempt: 'default',
        csrfToken: 'csrf-audio',
        idempotencyKey: `voice-${contentType}`,
      },
      { fetcher },
    );

    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('rejects an unsupported recording type and out-of-bounds durations before fetching', async () => {
    const fetcher = vi.fn(async () => transcriptionResponse());
    const baseRequest = {
      audio: new Blob(['audio'], { type: 'audio/flac' }),
      durationMs: 1,
      attempt: 'default' as const,
      csrfToken: 'csrf-invalid',
      idempotencyKey: 'voice-invalid',
    };

    await expect(
      transcribeVoice(baseRequest, { fetcher }),
    ).rejects.toMatchObject({
      code: 'invalid-request',
    });
    await expect(
      transcribeVoice(
        {
          ...baseRequest,
          audio: new Blob(['audio'], { type: 'audio/webm' }),
          durationMs: 60_001,
        },
        { fetcher },
      ),
    ).rejects.toBeInstanceOf(VoiceApiError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('requires the exact versioned transcription response and server-owned model IDs', async () => {
    const malformedPayloads = [
      { schemaVersion: 2 },
      { model: 'transcription-deployment-canary' },
      { attempt: 'accuracy-retry' },
      { spendWarning: 'false' },
      { replayed: undefined },
      { unexpected: true },
    ];

    for (const overrides of malformedPayloads) {
      const fetcher = vi.fn(async () => transcriptionResponse(overrides));
      await expect(
        transcribeVoice(
          {
            audio: new Blob(['audio'], { type: 'audio/webm' }),
            durationMs: 1_000,
            attempt: 'default',
            csrfToken: 'csrf-model',
            idempotencyKey: 'voice-model',
          },
          { fetcher },
        ),
      ).rejects.toMatchObject({ code: 'unsafe-response' });
    }
  });

  it('rejects a cacheable or tagged speech response', async () => {
    const unsafeFetcher = vi.fn(
      async () =>
        new Response(new Blob(['audio']), {
          status: 200,
          headers: { 'content-type': 'audio/mpeg', etag: 'unsafe' },
        }),
    );

    await expect(
      speakSummary(
        {
          text: 'Your spoken summary.',
          csrfToken: 'csrf-3',
          idempotencyKey: 'speech-1',
        },
        { fetcher: unsafeFetcher },
      ),
    ).rejects.toThrow('EMDO rejected an unsafe speech response.');
  });

  it('rejects speech text beyond the shared 4096-character provider limit before fetching', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(new Blob(['audio']), {
          status: 200,
          headers: { ...safeHeaders, 'content-type': 'audio/mpeg' },
        }),
    );

    await expect(
      speakSummary(
        {
          text: 'x'.repeat(4_097),
          csrfToken: 'csrf-speech-limit',
          idempotencyKey: 'speech-over-provider-limit',
        },
        { fetcher },
      ),
    ).rejects.toMatchObject({ code: 'invalid-request' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('sends only the versioned speech fields and keeps the response model header opaque', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(new Blob(['audio'], { type: 'audio/wav' }), {
          status: 200,
          headers: {
            ...safeHeaders,
            'content-type': 'audio/wav',
            'x-emdo-audio-model': 'speech-deployment-canary',
          },
        }),
    );

    const response = await speakSummary(
      {
        text: '  Your spoken summary.  ',
        voice: 'coral',
        csrfToken: 'csrf-4',
        idempotencyKey: 'speech-2',
      },
      { fetcher },
    );

    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('x-emdo-audio-model')).toBe(
      'speech-deployment-canary',
    );
    const [url, init] = fetcher.mock.calls[0]! as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe('/api/v1/voice/speak');
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
    });
    expect(init.headers).toEqual({
      accept: 'audio/*',
      'content-type': 'application/json',
      'idempotency-key': 'speech-2',
      'x-csrf-token': 'csrf-4',
    });
    expect(JSON.parse(String(init.body))).toEqual({
      schemaVersion: 1,
      voice: 'coral',
      text: 'Your spoken summary.',
    });
  });
});
