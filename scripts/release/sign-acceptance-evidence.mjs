#!/usr/bin/env node

import { createHash, createPrivateKey, sign } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import {
  ACCEPTANCE_EVIDENCE_FILENAME,
  canonicalJson,
  readStrictRegularFile,
} from './acceptance-evidence.mjs';

const parseArguments = (argv) => {
  const expected = [
    '--manifest',
    '--private-key',
    '--digest-output',
    '--signature-output',
  ];
  if (argv.length !== expected.length * 2) {
    throw new Error('Acceptance evidence signing arguments are incomplete.');
  }
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!expected.includes(flag) || values.has(flag) || value === undefined) {
      throw new Error('Acceptance evidence signing arguments are invalid.');
    }
    values.set(flag, value);
  }
  return values;
};

export const runAcceptanceEvidenceSigning = async (argv) => {
  const arguments_ = parseArguments(argv);
  const [manifestText, privateKeyPem] = await Promise.all([
    readStrictRegularFile(arguments_.get('--manifest')),
    readStrictRegularFile(arguments_.get('--private-key'), 16_384),
  ]);
  let parsed;
  try {
    parsed = JSON.parse(manifestText);
  } catch {
    throw new Error('Acceptance evidence manifest is not valid JSON.');
  }
  if (manifestText !== `${canonicalJson(parsed)}\n`) {
    throw new Error('Acceptance evidence manifest is not canonical JSON.');
  }
  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('Acceptance evidence signing key must be Ed25519.');
  }
  const digest = createHash('sha256').update(manifestText).digest('hex');
  const signature = sign(null, Buffer.from(manifestText, 'utf8'), privateKey);
  await Promise.all([
    writeFile(
      arguments_.get('--digest-output'),
      `${digest}  ${ACCEPTANCE_EVIDENCE_FILENAME}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    ),
    writeFile(
      arguments_.get('--signature-output'),
      `${signature.toString('base64')}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    ),
  ]);
  return Object.freeze({ digest });
};

const isDirectExecution =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  try {
    const result = await runAcceptanceEvidenceSigning(process.argv.slice(2));
    process.stdout.write(
      `Acceptance evidence signed: sha256:${result.digest}\n`,
    );
  } catch {
    process.stderr.write('Acceptance evidence signing failed.\n');
    process.exitCode = 1;
  }
}
