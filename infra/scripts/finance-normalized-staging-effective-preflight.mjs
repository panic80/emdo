import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { validateNormalizedStagingEnvironment } from './finance-normalized-staging-preflight.mjs';
// Compose output contains credentials: consume only a private root-owned run file,
// never print the input or exception details.
try {
  if (process.argv.length !== 3) throw new Error();
  const file = await open(
    process.argv[2],
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  let config;
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid() ||
      stat.mode & 0o077 ||
      stat.size > 1048576
    )
      throw new Error();
    config = JSON.parse(await file.readFile('utf8'));
  } finally {
    await file.close();
  }
  validateNormalizedStagingEnvironment(
    config.services.api.environment,
    config.services.worker.environment,
    'postgresql://postgres:5432/emdo_app',
  );
} catch {
  process.stderr.write('Normalized effective staging configuration invalid.\n');
  process.exitCode = 1;
}
