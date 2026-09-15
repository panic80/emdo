import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const fields = [
  ['bookId', 'BOOK_ID'],
  ['financialAccountId', 'FINANCIAL_ACCOUNT_ID'],
  ['cashAccountId', 'CASH_ACCOUNT_ID'],
  ['counterAccountId', 'COUNTER_ACCOUNT_ID'],
];
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizedFixtureEnvironment(seed, environment) {
  if (
    environment.EMDO_ENVIRONMENT !== 'staging' ||
    environment.EMDO_SYNTHETIC_DATA_ONLY !== 'true' ||
    environment.EMDO_FINANCE_NORMALIZED_SYNTHETIC_STAGING !== 'true'
  )
    throw new Error('normalized-synthetic-staging-only');
  if (
    seed?.status !== 'seeded' ||
    seed.operationCount !== 3 ||
    !seed.normalizedFinance ||
    fields.some(
      ([key]) =>
        typeof seed.normalizedFinance[key] !== 'string' ||
        !uuid.test(seed.normalizedFinance[key]),
    ) ||
    new Set(fields.map(([key]) => seed.normalizedFinance[key])).size !==
      fields.length
  )
    throw new Error('normalized-synthetic-seed-result-invalid');
  return (
    fields
      .map(
        ([key, suffix]) =>
          `EMDO_FINANCE_NORMALIZED_SYNTHETIC_${suffix}=${seed.normalizedFinance[key]}`,
      )
      .join('\n') + '\n'
  );
}

/** Local handoff only: no credentials, database mutation or service activation. */
export async function writeNormalizedFixtureEnvironment(
  seedPath,
  outputPath,
  environment,
) {
  if (
    !isAbsolute(seedPath) ||
    !isAbsolute(outputPath) ||
    resolve(seedPath) === resolve(outputPath)
  )
    throw new Error('normalized-handoff-distinct-absolute-paths-required');
  const input = await open(seedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let contents;
  try {
    const stat = await input.stat();
    if (!stat.isFile() || stat.size > 4096)
      throw new Error('normalized-handoff-seed-file-invalid');
    contents = normalizedFixtureEnvironment(
      JSON.parse(await input.readFile('utf8')),
      environment,
    );
  } finally {
    await input.close();
  }
  // Exclusive creation also rejects an existing file or symlink; never replace a run's handoff.
  const output = await open(outputPath, 'wx', 0o600);
  try {
    await output.writeFile(contents, 'utf8');
    await output.sync();
  } finally {
    await output.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [, , first, seedPath, second, outputPath, ...extra] = process.argv;
  try {
    if (
      first !== '--seed-result' ||
      second !== '--output' ||
      !seedPath ||
      !outputPath ||
      extra.length
    )
      throw new Error('normalized-handoff-arguments-invalid');
    await writeNormalizedFixtureEnvironment(seedPath, outputPath, process.env);
    process.stdout.write('Normalized synthetic fixture handoff saved.\n');
  } catch {
    process.stderr.write(
      'Normalized synthetic fixture handoff failed; check explicit staging flags, validated seed result and a new absolute output path.\n',
    );
    process.exitCode = 1;
  }
}
