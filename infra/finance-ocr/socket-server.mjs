import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { chmod, lstat, unlink } from 'node:fs/promises';

const path = '/run/emdo/finance-ocr/helper.sock';
const executable = '/usr/local/bin/emdo-finance-ocr-helper';
const maximumBytes = 52 * 1024 * 1024;
const environment = {
  PATH: '/usr/local/bin:/usr/bin:/bin',
  HOME: '/tmp',
  TMPDIR: '/tmp',
  LANG: 'C',
  LC_ALL: 'C',
  MAGICK_CONFIGURE_PATH: '/etc/ImageMagick-6',
  TESSDATA_PREFIX: '/usr/share/tesseract-ocr/5/tessdata',
};
// Only a stale socket may be removed. Never follow or replace a caller's file.
try {
  if (!(await lstat(path)).isSocket())
    throw new Error('ocr-socket-path-invalid');
  await unlink(path);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
let active;
const server = createServer({ allowHalfOpen: true }, (socket) => {
  if (active) {
    socket.destroy();
    return;
  }
  const child = spawn(executable, [], {
    env: environment,
    cwd: '/tmp',
    detached: true,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  let received = 0,
    sent = 0,
    finished = false;
  const stop = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* Already exited. */
      }
    }
    socket.destroy();
  };
  active = stop;
  const timer = setTimeout(stop, 16000);
  socket.on('data', (bytes) => {
    received += bytes.length;
    if (received > maximumBytes) stop();
  });
  child.stdout.on('data', (bytes) => {
    sent += bytes.length;
    if (sent > maximumBytes) stop();
  });
  socket.on('error', stop);
  socket.on('close', stop);
  child.stdin.on('error', stop);
  child.stdout.on('error', stop);
  child.on('error', stop);
  child.on('close', (code) => {
    clearTimeout(timer);
    active = undefined;
    if (code !== 0) stop();
    else {
      finished = true;
      socket.end();
    }
  });
  socket.pipe(child.stdin);
  child.stdout.pipe(socket, { end: false });
});
server.on('error', () => {
  active?.();
  process.exitCode = 1;
});
server.listen(path, async () => {
  await chmod(path, 0o660);
});
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    active?.();
    server.close();
  });
}
