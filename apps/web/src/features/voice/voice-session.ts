export interface RecorderHandle {
  readonly start: () => void;
  readonly stop: () => void;
  readonly dispose: () => void;
}

export interface VoiceCaptureDependencies {
  readonly createRecorder: (callbacks: {
    readonly onChunk: (chunk: Blob) => void;
    readonly onStop: () => void;
  }) => Promise<RecorderHandle>;
  readonly transcribe: (
    audio: Blob,
    model: 'fast' | 'accurate',
  ) => Promise<{ readonly transcript: string }>;
  readonly schedule?: (callback: () => void, delayMs: number) => unknown;
  readonly cancelSchedule?: (handle: unknown) => void;
}

export type VoiceCaptureSnapshot =
  | { readonly phase: 'idle' | 'requesting' | 'recording' | 'transcribing' }
  | { readonly phase: 'review'; readonly transcript: string }
  | { readonly phase: 'unavailable' | 'error'; readonly error: string };

export class VoiceCaptureSession {
  readonly #dependencies: VoiceCaptureDependencies;
  readonly #schedule: (callback: () => void, delayMs: number) => unknown;
  readonly #cancelSchedule: (handle: unknown) => void;
  #state: VoiceCaptureSnapshot = { phase: 'idle' };
  #recorder?: RecorderHandle;
  #timeout?: unknown;
  #chunks: Blob[] = [];
  #audio?: Blob;
  #transcriptionPromise?: Promise<void>;

  public constructor(dependencies: VoiceCaptureDependencies) {
    this.#dependencies = dependencies;
    this.#schedule =
      dependencies.schedule ??
      ((callback, delay) => setTimeout(callback, delay));
    this.#cancelSchedule =
      dependencies.cancelSchedule ??
      ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  public get hasAudioForAccuracyRetry(): boolean {
    return Boolean(this.#audio);
  }

  public snapshot(): VoiceCaptureSnapshot {
    return structuredClone(this.#state);
  }

  public async start(): Promise<void> {
    this.release();
    this.#state = { phase: 'requesting' };
    try {
      this.#recorder = await this.#dependencies.createRecorder({
        onChunk: (chunk) => {
          if (chunk.size > 0) this.#chunks.push(chunk);
        },
        onStop: () => {
          void this.#transcribe('fast');
        },
      });
      this.#state = { phase: 'recording' };
      this.#recorder.start();
      this.#timeout = this.#schedule(() => {
        void this.stop();
      }, 60_000);
    } catch {
      this.#recorder?.dispose();
      this.#recorder = undefined;
      this.#chunks = [];
      this.#state = {
        phase: 'unavailable',
        error:
          'Microphone access is unavailable. You can type your request instead.',
      };
    }
  }

  public async stop(): Promise<void> {
    if (this.#state.phase !== 'recording') return;
    if (this.#timeout !== undefined) this.#cancelSchedule(this.#timeout);
    this.#timeout = undefined;
    this.#state = { phase: 'transcribing' };
    this.#recorder?.stop();
  }

  public async finishForTest(): Promise<void> {
    if (this.#state.phase === 'recording') await this.stop();
    await this.#transcribe('fast');
  }

  async #transcribe(model: 'fast' | 'accurate'): Promise<void> {
    if (this.#transcriptionPromise) return this.#transcriptionPromise;
    this.#transcriptionPromise = (async () => {
      this.#state = { phase: 'transcribing' };
      if (!this.#audio)
        this.#audio = new Blob(this.#chunks, { type: 'audio/webm' });
      this.#chunks = [];
      try {
        const result = await this.#dependencies.transcribe(this.#audio, model);
        this.#state = { phase: 'review', transcript: result.transcript };
      } catch {
        this.#state = {
          phase: 'error',
          error:
            'EMDO could not transcribe that recording. You can retry or type instead.',
        };
      } finally {
        this.#transcriptionPromise = undefined;
      }
    })();
    return this.#transcriptionPromise;
  }

  public editTranscript(transcript: string): void {
    if (this.#state.phase !== 'review') return;
    this.#state = { phase: 'review', transcript };
  }

  public async retryForAccuracy(): Promise<void> {
    if (!this.#audio) throw new Error('No in-memory recording remains.');
    this.#state = { phase: 'transcribing' };
    try {
      const result = await this.#dependencies.transcribe(
        this.#audio,
        'accurate',
      );
      this.#state = { phase: 'review', transcript: result.transcript };
    } catch {
      this.#state = {
        phase: 'error',
        error:
          'The accuracy retry failed. You can edit the existing transcript or type instead.',
      };
    }
  }

  public release(): void {
    if (this.#timeout !== undefined) this.#cancelSchedule(this.#timeout);
    this.#timeout = undefined;
    this.#recorder?.dispose();
    this.#recorder = undefined;
    this.#chunks = [];
    this.#audio = undefined;
    this.#state = { phase: 'idle' };
  }
}

export interface AudioHandle {
  src: string;
  currentTime: number;
  onended: null | (() => void);
  readonly play: () => Promise<void>;
  readonly pause: () => void;
}

interface SpokenReplyDependencies {
  readonly audio: AudioHandle;
  readonly createObjectURL: (blob: Blob) => string;
  readonly revokeObjectURL: (url: string) => void;
}

export interface SpokenReplySnapshot {
  readonly phase: 'idle' | 'ready' | 'playing' | 'paused' | 'stopped';
  readonly captions?: string;
  readonly initiatingTurnId?: string;
}

export class SpokenReplyController {
  readonly #dependencies: SpokenReplyDependencies;
  #objectUrl?: string;
  #state: SpokenReplySnapshot = { phase: 'idle' };

  public constructor(dependencies: SpokenReplyDependencies) {
    this.#dependencies = dependencies;
  }

  public snapshot(): SpokenReplySnapshot {
    return { ...this.#state };
  }

  public async load(
    response: Response,
    metadata: { readonly initiatingTurnId: string; readonly captions: string },
  ): Promise<void> {
    const cacheControl =
      response.headers.get('cache-control')?.toLowerCase() ?? '';
    if (
      !cacheControl
        .split(',')
        .some((directive) => directive.trim() === 'no-store')
    ) {
      throw new Error('Speech responses must use Cache-Control: no-store.');
    }
    this.#releaseUrl();
    const audio = await response.blob();
    this.#objectUrl = this.#dependencies.createObjectURL(audio);
    this.#dependencies.audio.src = this.#objectUrl;
    this.#dependencies.audio.onended = () => {
      this.#dependencies.audio.currentTime = 0;
      this.#releaseUrl();
      this.#state = { ...metadata, phase: 'stopped' };
    };
    this.#state = { ...metadata, phase: 'ready' };
  }

  public async play(turnId: string): Promise<void> {
    if (turnId !== this.#state.initiatingTurnId) {
      throw new Error(
        'Spoken replies only play for the push-to-talk turn that requested them.',
      );
    }
    if (!this.#objectUrl) throw new Error('No spoken reply is ready.');
    await this.#dependencies.audio.play();
    this.#state = { ...this.#state, phase: 'playing' };
  }

  public pause(): void {
    if (this.#state.phase !== 'playing') return;
    this.#dependencies.audio.pause();
    this.#state = { ...this.#state, phase: 'paused' };
  }

  public async replay(turnId: string): Promise<void> {
    this.#dependencies.audio.currentTime = 0;
    await this.play(turnId);
  }

  public stop(): void {
    this.#dependencies.audio.pause();
    this.#dependencies.audio.currentTime = 0;
    this.#releaseUrl();
    this.#state = { ...this.#state, phase: 'stopped' };
  }

  public dispose(): void {
    this.stop();
    this.#dependencies.audio.onended = null;
    this.#dependencies.audio.src = '';
  }

  #releaseUrl(): void {
    if (!this.#objectUrl) return;
    this.#dependencies.revokeObjectURL(this.#objectUrl);
    this.#objectUrl = undefined;
  }
}
