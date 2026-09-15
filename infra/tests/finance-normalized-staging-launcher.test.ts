import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
const common = readFileSync('infra/scripts/_common.sh', 'utf8');
const compose = common.slice(
  common.indexOf('staging_compose() {'),
  common.indexOf('\nexpected_image_for_service()'),
);
const run = (code: string) =>
  spawnSync(
    'bash',
    ['-c', `set -Eeuo pipefail\ndie() { echo "$*" >&2; exit 1; }\n${code}`],
    { encoding: 'utf8' },
  );
it.each([
  'up --detach',
  '--profile operations run --rm staging-acceptance',
  'down --volumes',
])('selects the fourth overlay consistently for %s', (action) => {
  const result = run(
    `${compose}\nCOMPOSE_DIR=/compose\nCOMPOSE_PROJECT_NAME=emdo-staging-123\nEMDO_FINANCE_SYNTHETIC_STAGING=true\nEMDO_FINANCE_NORMALIZED_SYNTHETIC_STAGING=true\ndocker() { printf '%s\\n' "$@"; }\nstaging_compose ${action}`,
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.match(/compose\.[\w.-]+yml/g)).toEqual([
    'compose.staging.yml',
    'compose.finance-staging.yml',
    'compose.finance-normalized-staging.yml',
  ]);
});
it.each(['false', 'unset'])(
  'keeps normalized overlay absent with %s opt in',
  (flag) => {
    const result = run(
      `${compose}\nCOMPOSE_DIR=/compose\nCOMPOSE_PROJECT_NAME=test\nEMDO_FINANCE_SYNTHETIC_STAGING=true\n${flag === 'unset' ? 'unset EMDO_FINANCE_NORMALIZED_SYNTHETIC_STAGING' : 'EMDO_FINANCE_NORMALIZED_SYNTHETIC_STAGING=false'}\ndocker() { printf '%s\\n' "$@"; }\nstaging_compose config`,
    );
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('normalized');
  },
);
it.each(['true', 'invalid'])(
  'rejects missing base Finance or invalid normalized flag %s before Docker',
  (flag) => {
    const result = run(
      `${compose}\nCOMPOSE_DIR=/compose\nCOMPOSE_PROJECT_NAME=test\nEMDO_FINANCE_SYNTHETIC_STAGING=false\nEMDO_FINANCE_NORMALIZED_SYNTHETIC_STAGING=${flag}\ndocker() { echo UNEXPECTED_DOCKER; }\nstaging_compose config`,
    );
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain('UNEXPECTED_DOCKER');
  },
);
it.each([
  ['true', '', ''],
  ['true', '101', '500'],
  ['true', '10', '9'],
  ['true', '1', '501'],
  ['false', '1', '2'],
])(
  'rejects invalid explicit budget tuple %s/%s/%s before host mutation',
  (flag, perRun, perDay) => {
    const script = readFileSync('infra/scripts/deploy-staging.sh', 'utf8');
    const validation = script.slice(
      script.indexOf('finance_normalized='),
      script.indexOf('assert_safe_identifier'),
    );
    const result = run(
      `set -- 123 images 60 true false '${flag}' '${perRun}' '${perDay}'\nfinance_synthetic_staging=true\n${validation}`,
    );
    expect(result.status).not.toBe(0);
  },
);
it('effective preflight rejects malformed private Compose input without disclosing it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'normalized-effective-'));
  try {
    const input = join(dir, 'config.json');
    writeFileSync(input, '{"secret":"DO-NOT-LOG-ME"}', { mode: 0o600 });
    const result = spawnSync(
      process.execPath,
      [
        'infra/scripts/finance-normalized-staging-effective-preflight.mjs',
        input,
      ],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).not.toContain('DO-NOT-LOG-ME');
    expect(result.stderr).toContain('configuration invalid');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it.each([false, true])(
  'seed failure=%s gates the exclusive handoff and bounded provision before worker startup',
  (failSeed) => {
    const dir = mkdtempSync(join(tmpdir(), 'normalized-lifecycle-'));
    try {
      const script = readFileSync('infra/scripts/deploy-staging.sh', 'utf8');
      const start = script.indexOf(
        'if [[ "$finance_normalized" == true ]]; then\n  normalized_seed=',
      );
      const end = script.indexOf('\ndeadline_pending=', start);
      const result = run(
        `
state_dir="$1"
SCRIPT_DIR="$2/infra/scripts"
FINANCE_STAGING_SECRET_DIR=finance-secrets
mkdir "$state_dir/finance-secrets"
SECRETS_DIR="$state_dir"
finance_normalized=true
normalized_max_run=10
normalized_max_day=20
export EMDO_ENVIRONMENT=staging EMDO_FINANCE_NORMALIZED_SYNTHETIC_STAGING=true
staging_compose() {
  echo "$*" >> "$state_dir/trace"
  if [[ "$*" == *synthetic-data ]]; then
    ${failSeed ? 'return 1' : `printf '%s\\n' '{"status":"seeded","operationCount":3,"normalizedFinance":{"bookId":"00000000-0000-4000-8000-000000000001","financialAccountId":"00000000-0000-4000-8000-000000000002","cashAccountId":"00000000-0000-4000-8000-000000000003","counterAccountId":"00000000-0000-4000-8000-000000000004"}}'`}
  elif [[ "$*" == *'SELECT workspace_id'* ]]; then
    echo 00000000-0000-4000-8000-000000000005
  elif [[ "$*" == *normalized_staging=true* ]]; then
    cat >/dev/null
  fi
}
load_finance_normalized_staging_state() { FINANCE_NORMALIZED_STAGING_FIXTURE_ENV_FILE="$state_dir/finance-secrets/normalized-fixture.env"; }
env_file_value() {
  case "$2" in
    EMDO_FINANCE_NORMALIZED_SYNTHETIC_BOOK_ID) echo 00000000-0000-4000-8000-000000000001 ;;
    EMDO_BOOTSTRAP_HOUSEHOLD_SLUG) echo synthetic ;;
    EMDO_SYNTHETIC_OWNER_EMAIL) echo owner@synthetic.invalid ;;
  esac
}
wait_for_compose_healthy() { echo HEALTHY >> "$state_dir/trace"; }
${script.slice(start, end)}
`
          .replace('state_dir="$1"', `state_dir='${dir}'`)
          .replace(
            'SCRIPT_DIR="$2/infra/scripts"',
            `SCRIPT_DIR='${process.cwd()}/infra/scripts'`,
          ),
      );
      const trace = readFileSync(join(dir, 'trace'), 'utf8');
      if (failSeed) {
        expect(result.status).not.toBe(0);
        expect(trace).not.toContain('normalized_staging=true');
        expect(trace).not.toContain('up --detach');
      } else {
        expect(result.status, result.stderr).toBe(0);
        expect(
          readFileSync(
            join(dir, 'finance-secrets/normalized-fixture.env'),
            'utf8',
          ),
        ).toContain('00000000-0000-4000-8000-000000000001');
        expect(trace).toContain(
          '--set max_run_cad_minor=10 --set max_day_cad_minor=20',
        );
        expect(trace.indexOf('normalized_staging=true')).toBeLessThan(
          trace.indexOf('up --detach'),
        );
        expect(trace).toContain('HEALTHY');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

it('prepares a nonempty placeholder accepted by lifecycle file validation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'normalized-prepare-'));
  const start = common.indexOf('load_finance_normalized_staging_state() {');
  const end = common.indexOf(
    '\nassert_finance_normalized_effective_environment()',
    start,
  );
  try {
    const result = run(`
${common.slice(start, end)}
FINANCE_STAGING_SECRET_DIR=finance-secrets
state='${dir}'
SECRETS_DIR="$state/base"
mkdir "$state/finance-secrets" "$SECRETS_DIR"
printf '%s\\n' 'EMDO_EXTERNAL_PROVIDERS_ENABLED=false' > "$SECRETS_DIR/worker.env"
chown() { :; }
assert_root_owned_bounded_file() { [[ -f "$1" && ! -L "$1" && -s "$1" && $(wc -c < "$1") -le "$3" ]] || die unsafe; }
prepare_finance_normalized_staging_state "$state" synthetic-keyring synthetic-key synthetic-pricing 1 1
[[ "$EMDO_FINANCE_NORMALIZED_SYNTHETIC_STAGING" == true ]]
[[ "$FINANCE_NORMALIZED_STAGING_FIXTURE_ENV_FILE" == */normalized-fixture-placeholder.env ]]
load_finance_normalized_staging_state "$state"
`);
    expect(result.status, result.stderr).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('reloads durable normalized mode for acceptance and teardown and rejects incomplete credentials', () => {
  const dir = mkdtempSync(join(tmpdir(), 'normalized-state-'));
  const start = common.indexOf('load_finance_normalized_staging_state() {');
  const end = common.indexOf(
    '\nprepare_finance_normalized_staging_state()',
    start,
  );
  const loader = common.slice(start, end);
  try {
    const result = run(`
${loader}
FINANCE_STAGING_SECRET_DIR=finance-secrets
state='${dir}'
mkdir "$state/finance-secrets"
assert_root_owned_bounded_file() { [[ -f "$1" && ! -L "$1" ]] || die unsafe; }
EMDO_FINANCE_NORMALIZED_SYNTHETIC_STAGING=true
load_finance_normalized_staging_state "$state"
[[ "$EMDO_FINANCE_NORMALIZED_SYNTHETIC_STAGING" == false ]]
touch "$state/finance-secrets/normalized-api.env" "$state/finance-secrets/normalized-worker.env" "$state/finance-secrets/normalized-fixture-placeholder.env"
load_finance_normalized_staging_state "$state"
[[ "$EMDO_FINANCE_NORMALIZED_SYNTHETIC_STAGING" == true ]]
[[ "$FINANCE_NORMALIZED_STAGING_FIXTURE_ENV_FILE" == */normalized-fixture-placeholder.env ]]
touch "$state/finance-secrets/normalized-fixture.env"
load_finance_normalized_staging_state "$state"
[[ "$FINANCE_NORMALIZED_STAGING_FIXTURE_ENV_FILE" == */normalized-fixture.env ]]
rm "$state/finance-secrets/normalized-worker.env"
load_finance_normalized_staging_state "$state"
echo UNEXPECTED_SUCCESS
`);
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain('UNEXPECTED_SUCCESS');
    expect(result.stderr).toContain('unsafe');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('rejects an orphan normalized egress network in initial and teardown absence proof', () => {
  const start = common.indexOf('assert_isolated_project_absent() {');
  const end = common.indexOf('\nproduction_compose()', start);
  const result = run(`
${common.slice(start, end)}
assert_safe_identifier() { :; }
docker() {
  if [[ "$*" == *'network ls'* && "$*" == *'finance-normalized-egress'* ]]; then echo orphan-network; fi
}
assert_isolated_project_absent emdo-staging-123 staging-123
echo UNEXPECTED_SUCCESS
`);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('emdo-staging-123-finance-normalized-egress');
  expect(result.stdout).not.toContain('UNEXPECTED_SUCCESS');
});

it.each([
  ['false', 1835008],
  ['true', 2686976],
])('preserves capacity headroom with normalized=%s', (flag, expected) => {
  const source = readFileSync('infra/scripts/preflight-staging.sh', 'utf8');
  const start = source.indexOf('case "${EMDO_FINANCE_NORMALIZED');
  const end = source.indexOf('\nreadonly MIN_FREE_DISK_KIB', start);
  const result = run(
    `EMDO_FINANCE_NORMALIZED_SYNTHETIC_STAGING=${flag}\n${source.slice(start, end)}\nprintf '%s' "$MIN_AVAILABLE_MEMORY_KIB"`,
  );
  expect(result.status).toBe(0);
  expect(Number(result.stdout)).toBe(expected);
  const steadyStateMiB = flag === 'true' ? 2080 : 1248;
  expect(Number(result.stdout) / 1024 - steadyStateMiB - 192).toBe(352);
});
