import { pathToFileURL } from 'node:url';

import { runOwnerBootstrapCommand } from '@emdo/db/deployment/bootstrap-owner-command';

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  pathToFileURL(invokedPath).href === import.meta.url
) {
  process.exitCode = await runOwnerBootstrapCommand({
    environment: process.env,
  });
}
