import { pathToFileURL } from 'node:url';

import {
  OWNER_BOOTSTRAP_CONFIRMATION,
  runOwnerBootstrapCommand,
  type BootstrapOwnerEnvironment,
} from '@emdo/db/deployment/bootstrap-owner-command';

export const API_OWNER_BOOTSTRAP_CONFIRMATION = OWNER_BOOTSTRAP_CONFIRMATION;

type BootstrapOwner = typeof runOwnerBootstrapCommand;

export interface ApiOwnerBootstrapLogger {
  error(message: string): void;
}

const defaultLogger: ApiOwnerBootstrapLogger = Object.freeze({
  error: (message: string): void => console.error(message),
});

const scopedBootstrapEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
): BootstrapOwnerEnvironment => ({
  EMDO_BOOTSTRAP_CONFIRM: API_OWNER_BOOTSTRAP_CONFIRMATION,
  EMDO_BOOTSTRAP_DATABASE_URL: environment.EMDO_BOOTSTRAP_DATABASE_URL,
  EMDO_BOOTSTRAP_HOUSEHOLD_NAME: environment.EMDO_BOOTSTRAP_HOUSEHOLD_NAME,
  EMDO_BOOTSTRAP_HOUSEHOLD_SLUG: environment.EMDO_BOOTSTRAP_HOUSEHOLD_SLUG,
  EMDO_BOOTSTRAP_OWNER_EMAIL: environment.EMDO_BOOTSTRAP_OWNER_EMAIL,
  EMDO_BOOTSTRAP_OWNER_NAME: environment.EMDO_BOOTSTRAP_OWNER_NAME,
  EMDO_BOOTSTRAP_OWNER_PASSWORD: environment.EMDO_BOOTSTRAP_OWNER_PASSWORD,
});

export const runApiOwnerBootstrapCommand = async (input: {
  readonly argv: readonly string[];
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly bootstrapOwner?: BootstrapOwner;
  readonly logger?: ApiOwnerBootstrapLogger;
}): Promise<number> => {
  const logger = input.logger ?? defaultLogger;
  if (
    input.argv.length !== 2 ||
    input.argv[0] !== '--confirm' ||
    input.argv[1] !== API_OWNER_BOOTSTRAP_CONFIRMATION
  ) {
    logger.error('Owner bootstrap configuration is invalid.');
    return 64;
  }

  return (input.bootstrapOwner ?? runOwnerBootstrapCommand)({
    environment: scopedBootstrapEnvironment(input.environment),
  });
};

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  pathToFileURL(invokedPath).href === import.meta.url
) {
  process.exitCode = await runApiOwnerBootstrapCommand({
    argv: process.argv.slice(2),
    environment: process.env,
  });
}
