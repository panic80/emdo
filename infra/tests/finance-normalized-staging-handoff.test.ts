import {
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const script = new URL(
  '../scripts/finance-normalized-staging-handoff.mjs',
  import.meta.url,
);
const environment = {
  ...process.env,
  EMDO_ENVIRONMENT: 'staging',
  EMDO_SYNTHETIC_DATA_ONLY: 'true',
  EMDO_FINANCE_NORMALIZED_SYNTHETIC_STAGING: 'true',
};
const seed = {
  status: 'seeded',
  operationCount: 3,
  normalizedFinance: {
    bookId: '71000000-0000-4000-8000-000000000001',
    financialAccountId: '71000000-0000-4000-8000-000000000002',
    cashAccountId: '71000000-0000-4000-8000-000000000003',
    counterAccountId: '71000000-0000-4000-8000-000000000004',
  },
};
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function fixture(value: unknown = seed) {
  const directory = await mkdtemp(join(tmpdir(), 'emdo-normalized-handoff-'));
  directories.push(directory);
  const input = join(directory, 'seed.json'),
    output = join(directory, 'fixture.env');
  await writeFile(input, JSON.stringify(value), { mode: 0o600 });
  return { input, output };
}
function run(input: string, output: string, env = environment) {
  return execFileSync(
    process.execPath,
    [fileURLToPath(script), '--seed-result', input, '--output', output],
    { env, stdio: 'pipe' },
  );
}
describe('normalized staging fixture handoff', () => {
  it('writes only validated IDs with private permissions and refuses replacement', async () => {
    const { input, output } = await fixture();
    run(input, output);
    const contents = await readFile(output, 'utf8');
    expect(contents.split('\n').filter(Boolean)).toHaveLength(4);
    expect(contents).toContain(
      `EMDO_FINANCE_NORMALIZED_SYNTHETIC_BOOK_ID=${seed.normalizedFinance.bookId}\n`,
    );
    expect((await stat(output)).mode & 0o777).toBe(0o600);
    expect(() => run(input, output)).toThrow();
    expect(await readFile(output, 'utf8')).toBe(contents);
  });
  it.each([
    'EMDO_ENVIRONMENT',
    'EMDO_SYNTHETIC_DATA_ONLY',
    'EMDO_FINANCE_NORMALIZED_SYNTHETIC_STAGING',
  ])('rejects missing staging boundary %s', async (key) => {
    const { input, output } = await fixture();
    expect(() => run(input, output, { ...environment, [key]: '' })).toThrow();
    await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rejects injected environment content and duplicate IDs before writing', async () => {
    for (const bookId of [
      'x\nOPENAI_API_KEY=unexpected',
      seed.normalizedFinance.cashAccountId,
    ]) {
      const { input, output } = await fixture({
        ...seed,
        normalizedFinance: { ...seed.normalizedFinance, bookId },
      });
      expect(() => run(input, output)).toThrow();
      await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });
  it('refuses symlink inputs and outputs without changing their target', async () => {
    const { input, output } = await fixture();
    await symlink(input, output);
    expect(() => run(input, output)).toThrow();
    expect(() => run(output, `${output}.new`)).toThrow();
    expect(JSON.parse(await readFile(input, 'utf8'))).toEqual(seed);
  });
});
