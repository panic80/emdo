import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const source = readFileSync('infra/scripts/run-staging-acceptance.sh', 'utf8');
const helper = source.slice(
  source.indexOf('prepare_normalized_authored_review() {'),
  source.indexOf('\nassert_compose_healthy staging_compose'),
);

const run = (setup: string) =>
  spawnSync(
    'bash',
    [
      '-c',
      `
set -Eeuo pipefail
die() { echo "$*" >&2; exit 1; }
log() { :; }
${helper}
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
marker="$dir/marker"
review="$dir/review"
assert_root_owned_bounded_file() { [[ "$1:$2:$3" == "$marker:600:5" ]] || exit 90; }
chown() { printf '%s\\n' "$*" > "$dir/chown"; }
realpath() { printf '%s' "$review"; }
stat() { printf '%s' "\${metadata:-10001:10001:700}"; }
${setup}
prepare_normalized_authored_review "$marker" "$review"
printf '<%s>\\n' "\${normalized_review_options[@]}"
`,
    ],
    { encoding: 'utf8' },
  );

it('leaves the Compose invocation unchanged without operator opt-in', () => {
  const result = run('');
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).not.toContain('--volume');
  expect(result.stdout).not.toContain('--env');
});

it('mounts a private run directory and sets the CLI opt-in only with a valid marker', () => {
  const result = run('printf "true\\n" > "$marker"');
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('<--volume>');
  expect(result.stdout).toContain('/review:/run/emdo-normalized-review:rw>');
  expect(result.stdout).toContain('<--env>');
  expect(result.stdout).toContain(
    'EMDO_FINANCE_NORMALIZED_SYNTHETIC_REVIEW_DIRECTORY=/run/emdo-normalized-review',
  );
});

it.each([
  'printf false > "$marker"',
  'ln -s missing "$marker"',
  'printf true > "$marker"; assert_root_owned_bounded_file() { die "unsafe marker"; }',
  'printf true > "$marker"; ln -s missing "$review"',
  'printf true > "$marker"; metadata=0:0:700',
  'printf true > "$marker"; metadata=10001:10001:755',
  'printf true > "$marker"; realpath() { echo /different; }',
])(
  'rejects unsafe operator configuration before passing mount options: %s',
  (setup) => {
    const result = run(setup);
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain('--volume');
  },
);

it('keeps review wiring confined to normalized acceptance and uses the protected marker path', () => {
  expect(source).toContain(
    'prepare_normalized_authored_review /etc/emdo/staging/normalized-authored-review "$state_dir/normalized-authored-review"',
  );
  expect(source).toContain(
    'run --rm --no-deps "${normalized_review_options[@]}" staging-acceptance > "$normalized_probe"',
  );
  expect(
    source.match(/prepare_normalized_authored_review \/etc/g),
  ).toHaveLength(1);
});

it('only enables the existing bounded human review protocol without generating answers', () => {
  const cli = readFileSync('apps/api/src/cli/staging-acceptance.ts', 'utf8');
  expect(cli).toContain('const NORMALIZED_REVIEW_WAIT_MS = 180_000;');
  expect(helper).not.toContain('.review.json');
  expect(helper).not.toContain('approve-authored-synthetic-mapping');
});
