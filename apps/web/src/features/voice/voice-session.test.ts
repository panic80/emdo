import { describe, expect, it, vi } from 'vitest';

import {
  SpokenReplyController,
  VoiceCaptureSession,
  type VoiceCaptureDependencies,
} from './voice-session.js';

function createCaptureDependencies() {
  let timeoutCallback: (() => void) | undefined;
  const recorder = {
    start: vi.fn(),
    stop: vi.fn(),
    dispose: vi.fn(),
  };
  const dependencies: VoiceCaptureDependencies = {
    createRecorder: vi.fn(async ({ onChunk, onStop }) => {
      onChunk(new Blob(['private audio'], { type: 'audio/webm' }));
      return { ...recorder, finish: onStop };
    }),
    transcribe: vi.fn(async (_audio, model) => ({
      transcript:
        model === 'accurate' ? 'accurate transcript' : 'draft transcript',
    })),
    schedule: vi.fn((callback) => {
      timeoutCallback = callback;
      return 1;
    }),
    cancelSchedule: vi.fn(),
  };
  return { dependencies, recorder, runTimeout: () => timeoutCallback?.() };
}

describe('push-to-talk memory lifecycle', () => {
  it('stops recording at 60 seconds and never writes audio to storage', async () => {
    const { dependencies, recorder, runTimeout } = createCaptureDependencies();
    const session = new VoiceCaptureSession(dependencies);

    await session.start();
    expect(dependencies.schedule).toHaveBeenCalledWith(
      expect.any(Function),
      60_000,
    );
    runTimeout();

    expect(recorder.stop).toHaveBeenCalledTimes(1);
    expect(session.snapshot().phase).toBe('transcribing');
    expect(JSON.stringify(session.snapshot())).not.toContain('private audio');
  });

  it('keeps the transcript editable and offers an explicit accuracy retry', async () => {
    const { dependencies } = createCaptureDependencies();
    const session = new VoiceCaptureSession(dependencies);

    await session.start();
    await session.finishForTest();
    let snapshot = session.snapshot();
    expect(snapshot.phase).toBe('review');
    if (snapshot.phase !== 'review')
      throw new Error('Expected a review transcript');
    expect(snapshot.transcript).toBe('draft transcript');

    session.editTranscript('corrected by the user');
    snapshot = session.snapshot();
    expect(snapshot.phase).toBe('review');
    if (snapshot.phase !== 'review')
      throw new Error('Expected an editable transcript');
    expect(snapshot.transcript).toBe('corrected by the user');

    await session.retryForAccuracy();
    expect(dependencies.transcribe).toHaveBeenLastCalledWith(
      expect.any(Blob),
      'accurate',
    );
    snapshot = session.snapshot();
    expect(snapshot.phase).toBe('review');
    if (snapshot.phase !== 'review')
      throw new Error('Expected an accuracy retry transcript');
    expect(snapshot.transcript).toBe('accurate transcript');
  });

  it('surfaces a microphone fallback without starting a partial recording', async () => {
    const { dependencies: baseDependencies } = createCaptureDependencies();
    const dependencies: VoiceCaptureDependencies = {
      ...baseDependencies,
      createRecorder: vi.fn(async () => {
        throw new DOMException('Permission denied', 'NotAllowedError');
      }),
    };
    const session = new VoiceCaptureSession(dependencies);

    await session.start();

    expect(session.snapshot()).toMatchObject({
      phase: 'unavailable',
      error:
        'Microphone access is unavailable. You can type your request instead.',
    });
  });

  it('drops the in-memory recording on send, navigation, or disposal', async () => {
    const { dependencies } = createCaptureDependencies();
    const session = new VoiceCaptureSession(dependencies);
    await session.start();
    await session.finishForTest();

    expect(session.hasAudioForAccuracyRetry).toBe(true);
    session.release();
    expect(session.hasAudioForAccuracyRetry).toBe(false);
    await expect(session.retryForAccuracy()).rejects.toThrow(
      'No in-memory recording remains.',
    );
  });
});

describe('spoken reply lifecycle', () => {
  it('requires no-store audio and revokes object URLs after completion and replacement', async () => {
    const audio = {
      src: '',
      play: vi.fn(async () => undefined),
      pause: vi.fn(),
      currentTime: 0,
      onended: null as null | (() => void),
    };
    const revokeObjectURL = vi.fn();
    const controller = new SpokenReplyController({
      audio,
      createObjectURL: vi.fn(() => 'blob:spoken-1'),
      revokeObjectURL,
    });

    await controller.load(
      new Response(new Blob(['summary']), {
        headers: {
          'cache-control': 'private, no-store',
          'content-type': 'audio/mpeg',
        },
      }),
      { initiatingTurnId: 'turn-1', captions: 'Your day is ready.' },
    );
    await controller.play('turn-1');
    audio.onended?.();

    expect(revokeObjectURL).toHaveBeenCalledWith('blob:spoken-1');
    expect(controller.snapshot().phase).toBe('stopped');
  });

  it('will not play for a different turn and supports pause, stop, replay, and captions', async () => {
    const audio = {
      src: '',
      play: vi.fn(async () => undefined),
      pause: vi.fn(),
      currentTime: 0,
      onended: null as null | (() => void),
    };
    const controller = new SpokenReplyController({
      audio,
      createObjectURL: () => 'blob:spoken-2',
      revokeObjectURL: vi.fn(),
    });
    await controller.load(
      new Response(new Blob(['summary']), {
        headers: { 'cache-control': 'no-store' },
      }),
      { initiatingTurnId: 'turn-2', captions: 'A spoken summary.' },
    );

    await expect(controller.play('turn-other')).rejects.toThrow(
      'Spoken replies only play for the push-to-talk turn that requested them.',
    );
    await controller.play('turn-2');
    controller.pause();
    await controller.replay('turn-2');
    controller.stop();

    expect(controller.snapshot().captions).toBe('A spoken summary.');
    expect(audio.currentTime).toBe(0);
    expect(audio.play).toHaveBeenCalledTimes(2);
  });

  it('rejects cacheable speech responses', async () => {
    const controller = new SpokenReplyController({
      audio: {
        src: '',
        play: async () => undefined,
        pause: () => undefined,
        currentTime: 0,
        onended: null,
      },
      createObjectURL: () => 'blob:unsafe',
      revokeObjectURL: vi.fn(),
    });

    await expect(
      controller.load(new Response(new Blob(['audio'])), {
        initiatingTurnId: 'turn-3',
        captions: 'Unsafe response',
      }),
    ).rejects.toThrow('Speech responses must use Cache-Control: no-store.');
  });
});
