import type { RecorderHandle } from './voice-session.js';

export async function createBrowserRecorder(callbacks: {
  readonly onChunk: (chunk: Blob) => void;
  readonly onStop: () => void;
}): Promise<RecorderHandle> {
  if (
    !navigator.mediaDevices?.getUserMedia ||
    typeof MediaRecorder === 'undefined'
  ) {
    throw new DOMException(
      'Media recording is not supported',
      'NotSupportedError',
    );
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      autoGainControl: true,
      echoCancellation: true,
      noiseSuppression: true,
    },
    video: false,
  });
  const preferredType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : 'audio/webm';
  const recorder = new MediaRecorder(stream, { mimeType: preferredType });
  let disposed = false;

  recorder.addEventListener('dataavailable', (event) =>
    callbacks.onChunk(event.data),
  );
  recorder.addEventListener('stop', () => {
    stream.getTracks().forEach((track) => track.stop());
    if (!disposed) callbacks.onStop();
  });

  return {
    start: () => recorder.start(1_000),
    stop: () => {
      if (recorder.state !== 'inactive') recorder.stop();
    },
    dispose: () => {
      disposed = true;
      if (recorder.state !== 'inactive') recorder.stop();
      stream.getTracks().forEach((track) => track.stop());
    },
  };
}
