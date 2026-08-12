import { useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '../../components/button.js';
import { Icon } from '../../components/icon.js';
import { createBrowserRecorder } from './browser-recorder.js';
import { transcribeVoice } from './voice-api.js';
import { VoiceCaptureSession } from './voice-session.js';

function newRequestId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function VoicePanel({
  open,
  csrfToken,
  onUseTranscript,
  onClose,
}: {
  readonly open: boolean;
  readonly csrfToken: string;
  readonly onUseTranscript: (transcript: string) => void;
  readonly onClose: () => void;
}) {
  const startedAt = useRef(0);
  const [snapshotVersion, setSnapshotVersion] = useState(0);
  const session = useMemo(
    () =>
      new VoiceCaptureSession({
        createRecorder: async (callbacks) => {
          startedAt.current = Date.now();
          return createBrowserRecorder(callbacks);
        },
        transcribe: async (audio, model) => {
          const result = await transcribeVoice({
            audio,
            durationMs: Math.min(
              60_000,
              Math.max(1, Date.now() - startedAt.current),
            ),
            attempt: model === 'accurate' ? 'accuracy-retry' : 'default',
            csrfToken,
            idempotencyKey: newRequestId('voice'),
          });
          return { transcript: result.transcript };
        },
      }),
    [csrfToken],
  );
  const snapshot = session.snapshot();

  useEffect(() => {
    if (!open) {
      session.release();
      return;
    }
    const timer = window.setInterval(
      () => setSnapshotVersion((value) => value + 1),
      250,
    );
    return () => {
      window.clearInterval(timer);
      session.release();
    };
  }, [open, session]);

  void snapshotVersion;
  if (!open) return null;

  const close = () => {
    session.release();
    onClose();
  };

  return (
    <div
      className="voice-panel__backdrop"
      role="presentation"
      onMouseDown={close}
    >
      <section
        aria-labelledby="voice-panel-title"
        aria-modal="true"
        className="voice-panel"
        role="dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <h2 id="voice-panel-title">Push to talk</h2>
            <p>Record up to 60 seconds. Audio stays in memory only.</p>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="Close voice input"
            onClick={close}
          >
            <Icon className="icon--close" name="plus" />
          </button>
        </header>

        <div className="voice-panel__body">
          {snapshot.phase === 'idle' ? (
            <button
              className="voice-record-button"
              onClick={() => {
                void session
                  .start()
                  .finally(() => setSnapshotVersion((value) => value + 1));
              }}
              type="button"
            >
              <Icon name="microphone" size={30} />
              <span>Start recording</span>
            </button>
          ) : null}

          {snapshot.phase === 'requesting' ? (
            <p role="status">Requesting microphone access…</p>
          ) : null}
          {snapshot.phase === 'recording' ? (
            <div className="voice-recording" role="status">
              <span className="voice-recording__pulse" aria-hidden="true" />
              <strong>Listening…</strong>
              <span>60 second maximum</span>
              <Button
                variant="secondary"
                onClick={() => {
                  void session
                    .stop()
                    .finally(() => setSnapshotVersion((value) => value + 1));
                }}
              >
                <Icon name="stop" size={18} /> Stop recording
              </Button>
            </div>
          ) : null}
          {snapshot.phase === 'transcribing' ? (
            <p role="status">Transcribing…</p>
          ) : null}
          {snapshot.phase === 'review' ? (
            <div className="voice-review">
              <label htmlFor="voice-transcript">
                Review and correct your transcript
              </label>
              <textarea
                id="voice-transcript"
                onChange={(event) => {
                  session.editTranscript(event.target.value);
                  setSnapshotVersion((value) => value + 1);
                }}
                rows={5}
                value={snapshot.transcript}
              />
              <div className="voice-review__actions">
                <Button
                  variant="secondary"
                  onClick={() => {
                    void session
                      .retryForAccuracy()
                      .finally(() => setSnapshotVersion((value) => value + 1));
                  }}
                >
                  Accuracy retry
                </Button>
                <Button
                  onClick={() => {
                    onUseTranscript(snapshot.transcript);
                    close();
                  }}
                >
                  Use transcript
                </Button>
              </div>
            </div>
          ) : null}
          {snapshot.phase === 'unavailable' || snapshot.phase === 'error' ? (
            <div className="voice-fallback" role="alert">
              <Icon name="info" />
              <p>{snapshot.error}</p>
              <Button variant="secondary" onClick={close}>
                Type instead
              </Button>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
