import { pathToFileURL } from 'node:url';

import { startApiFromEnvironment } from './main.js';

export * from './app.js';
export * from './agents/capability-runtime.js';
export * from './config.js';
export * from './main.js';
export * from './openapi.js';
export * from './problem.js';
export * from './production/create-services.js';
export * from './readiness-contract.js';
export * from './services/contracts.js';

const executablePath = process.argv[1];
if (
  executablePath !== undefined &&
  import.meta.url === pathToFileURL(executablePath).href
) {
  void startApiFromEnvironment().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : '';
    const code = /^api-[a-z0-9:.-]+$/u.test(message)
      ? message
      : 'api-startup-failed';
    process.stderr.write(`${JSON.stringify({ level: 'fatal', code })}\n`);
    process.exitCode = 1;
  });
}
