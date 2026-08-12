import { useEffect, useMemo, useState } from 'react';

import { Icon } from '../../components/icon.js';
import {
  SpokenReplyController,
  type AudioHandle,
  type SpokenReplySnapshot,
} from './voice-session.js';

export function SpokenReplyControls({
  response,
  turnId,
  captions,
}: {
  readonly response: Response;
  readonly turnId: string;
  readonly captions: string;
}) {
  const audio = useMemo(() => new Audio(), []);
  const audioHandle = useMemo<AudioHandle>(
    () => ({
      get src() {
        return audio.src;
      },
      set src(value) {
        audio.src = value;
      },
      get currentTime() {
        return audio.currentTime;
      },
      set currentTime(value) {
        audio.currentTime = value;
      },
      get onended() {
        return audio.onended ? () => audio.onended?.(new Event('ended')) : null;
      },
      set onended(handler) {
        audio.onended = handler ? () => handler() : null;
      },
      play: () => audio.play(),
      pause: () => audio.pause(),
    }),
    [audio],
  );
  const controller = useMemo(
    () =>
      new SpokenReplyController({
        audio: audioHandle,
        createObjectURL: (blob) => URL.createObjectURL(blob),
        revokeObjectURL: (url) => URL.revokeObjectURL(url),
      }),
    [audioHandle],
  );
  const [snapshot, setSnapshot] = useState<SpokenReplySnapshot>({
    phase: 'idle',
  });

  useEffect(() => {
    void controller
      .load(response, { initiatingTurnId: turnId, captions })
      .then(() => {
        setSnapshot(controller.snapshot());
      });
    return () => controller.dispose();
  }, [captions, controller, response, turnId]);

  const refresh = () => setSnapshot(controller.snapshot());
  return (
    <section className="spoken-reply" aria-label="Spoken reply">
      <button
        aria-label={
          snapshot.phase === 'playing'
            ? 'Pause spoken reply'
            : 'Play spoken reply'
        }
        onClick={() => {
          if (snapshot.phase === 'playing') {
            controller.pause();
            refresh();
            return;
          }
          void controller.play(turnId).then(refresh);
        }}
        type="button"
      >
        <Icon
          name={snapshot.phase === 'playing' ? 'pause' : 'play'}
          size={18}
        />
      </button>
      <button
        aria-label="Stop spoken reply"
        onClick={() => {
          controller.stop();
          refresh();
        }}
        type="button"
      >
        <Icon name="stop" size={18} />
      </button>
      <button
        disabled={snapshot.phase === 'stopped'}
        onClick={() => void controller.replay(turnId).then(refresh)}
        type="button"
      >
        Replay
      </button>
      <details>
        <summary>Captions</summary>
        <p>{snapshot.captions}</p>
      </details>
    </section>
  );
}
