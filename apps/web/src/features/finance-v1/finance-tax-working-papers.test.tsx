import { FinanceTaxCreate } from './finance-tax-create.js';
import { webcrypto } from 'node:crypto';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FinanceTaxWorkspace } from './finance-tax-workspace.js';
import {
  verifyTaxPreparation,
  verifyTaxRun,
  verifyTaxExport,
  taxWorkingInputs,
} from './finance-tax-working-model.js';
import { taxWorkingFixture } from '../../../test/finance-tax-working-fixture.js';
import { taxCaseId } from '../../../test/finance-tax-fixture.js';
import { saveMemoryFile } from '../../downloads/save-memory-file.js';

const auth = vi.hoisted(() => ({
  state: 'authenticated',
  sessionBinding: 'tax-working-session',
  csrfToken: 'tax-csrf',
}));
vi.mock('../auth/auth-context.js', () => ({ useAuth: () => auth }));
vi.mock('../../downloads/save-memory-file.js', () => ({
  saveMemoryFile: vi.fn(),
}));
beforeEach(() => {
  auth.state = 'authenticated';
  auth.sessionBinding = 'tax-working-session';
  vi.stubGlobal('crypto', webcrypto);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.mocked(saveMemoryFile).mockClear();
});
function setup(role: 'owner' | 'preparer' | 'reviewer' | 'viewer' = 'owner') {
  const fixture = taxWorkingFixture();
  fixture.detail.caseRole = role;
  const writes: Array<{
    path: string;
    body: Record<string, unknown>;
    key: string;
  }> = [];
  const fetcher = vi.fn<
    (path: string, init?: RequestInit) => Promise<Response>
  >(async (path, init) => {
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : {};
    if (init?.method === 'POST') {
      const headers = new Headers(init.headers);
      expect(headers.get('x-csrf-token')).toBe('tax-csrf');
      expect(headers.get('idempotency-key')).toMatch(/^[a-f0-9-]{36}$/u);
      writes.push({ path, body, key: headers.get('idempotency-key')! });
    }
    const result = fixture.handle(path, init?.method, body);
    return new Response(JSON.stringify(result.json), { status: result.status });
  });
  vi.stubGlobal('fetch', fetcher);
  return { ...fixture, writes, fetcher };
}
async function openWorking() {
  fireEvent.click(
    await screen.findByRole('button', {
      name: 'Open tax case 2025 · Personal income tax',
    }),
  );
  fireEvent.click(
    await screen.findByRole('button', { name: /^Working papers$/u }),
  );
  await screen.findByLabelText('Working-paper input progress');
}
async function openFirstRun() {
  fireEvent.click(screen.getByRole('button', { name: /^Run history$/u }));
  fireEvent.click(
    await screen.findByRole('button', {
      name: /Incomplete working papers.*Snapshot revision/u,
    }),
  );
  return screen.findByRole('region', { name: 'Exact working-paper fields' });
}
describe('private tax working-paper boundaries', () => {
  it.each([
    ['salary individual', 'individual', 'declaracion-anual-pf-2025-sueldos'],
    [
      'professional sole proprietor',
      'sole-proprietor',
      'declaracion-anual-pf-2025-actividad-profesional',
    ],
    [
      'standalone corporation',
      'corporation',
      'declaracion-anual-pm-2025-regimen-general',
    ],
  ])(
    'sets exact Mexico %s scope without inventing residency',
    (label, type, formVersion) => {
      render(
        <FinanceTaxCreate
          busy={false}
          onSave={async () => {}}
          onCancel={() => {}}
        />,
      );
      fireEvent.click(
        screen.getByRole('button', { name: `Use Mexico 2025 ${label} scope` }),
      );
      expect(
        (screen.getByLabelText('Taxpayer type') as HTMLSelectElement).value,
      ).toBe(type);
      expect(
        (screen.getByLabelText('Country') as HTMLSelectElement).value,
      ).toBe('MX');
      expect(
        (
          screen.getByLabelText(
            /^Province, state or region code/,
          ) as HTMLInputElement
        ).value,
      ).toBe('MX-FED');
      expect(
        (
          screen.getByLabelText(
            /^Form and version reference/,
          ) as HTMLInputElement
        ).value,
      ).toBe(formVersion);
      expect(
        (
          screen.getByLabelText(
            'Domestic tax residency established',
          ) as HTMLSelectElement
        ).value,
      ).toBe('unknown');
    },
  );

  it('offers an explicit corporate scope preset without guessing residency or standalone facts', () => {
    render(
      <FinanceTaxCreate
        busy={false}
        onSave={async () => {}}
        onCancel={() => {}}
      />,
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Use Ontario 2025 corporate scope' }),
    );
    expect(
      (screen.getByLabelText('Taxpayer type') as HTMLSelectElement).value,
    ).toBe('corporation');
    expect((screen.getByLabelText('Country') as HTMLSelectElement).value).toBe(
      'CA',
    );
    expect(
      (screen.getByLabelText(/^Form and version reference/) as HTMLInputElement)
        .value,
    ).toBe('T2-2025_GIFI-2025_ON-2025');
    expect(
      (screen.getByLabelText('Standalone corporation') as HTMLSelectElement)
        .value,
    ).toBe('unknown');
  });
  it('keeps SAT exact decimals unitless when field units are not declared', async () => {
    const fixture = setup();
    fixture.approveInputs();
    const run = fixture.createRun();
    run.summary.workflowId = 'mx-fed-2025-working-papers';
    for (const schedule of run.schedules)
      for (const item of schedule.content)
        item.field.reporting.target = 'sat-2025-working-paper-field';
    render(<FinanceTaxWorkspace />);
    await openWorking();
    await openFirstRun();
    expect(screen.getAllByText('Exact decimal').length).toBeGreaterThan(0);
    expect(
      screen.queryByText(/Exact decimal · (CAD|MXN|USD)/),
    ).not.toBeInTheDocument();
  });
  it('renders corporate preparation through the same private declaration editor', async () => {
    const fixture = setup('preparer');
    vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
      const response = await fixture.fetcher(path, init);
      if (path.endsWith('/working-papers') && !init?.method) {
        const body = await response.json();
        return new Response(
          JSON.stringify({
            ...body,
            workflowId: 'ca-on-2025-corporate-working-papers',
            packageVersion: '2025.7',
            questions: [
              {
                key: 'identity.legalName',
                label: 'Corporate legal name',
                type: 'text',
                required: true,
                locator: 'T2 identity',
              },
              {
                key: 'corporate.taxInstalmentsPaid',
                label: 'Corporate tax instalments paid',
                type: 'decimal',
                required: true,
                locator: 'T2 line840',
              },
            ],
          }),
          { status: 200 },
        );
      }
      return response;
    });
    render(<FinanceTaxWorkspace />);
    await openWorking();
    expect(screen.getByText('Corporate identity')).toBeInTheDocument();
    expect(screen.getByText('Disclosures and payments')).toBeInTheDocument();
    expect(
      screen.getByText(/Limited Ontario 2025 standalone corporate/),
    ).toBeInTheDocument();
    expect(screen.getByText('Corporate legal name')).toBeInTheDocument();
    expect(
      screen.getByText('Corporate tax instalments paid'),
    ).toBeInTheDocument();
  });
  it('renders bound form readiness without identity values and rejects stale audit bindings', async () => {
    const fixture = setup();
    fixture.approveInputs();
    const run = fixture.createRun();
    run.output.formAudit = {
      version: '2025-personal-form-inventory.1',
      runHash: run.output.runHash,
      packageVersion: run.summary.packageVersion,
      formDataReady: false,
      fieldCount: 1271,
      unresolvedCount: 12,
      signature: { status: 'manual-unperformed', blocksCalculation: false },
      requirements: [
        {
          key: 'identity.taxNumber',
          type: 'text',
          required: true,
          satisfied: false,
          sourceId: 'cra-5006-r-2025-fillable',
          sourceBinding: null,
        },
      ],
      issues: ['missing-or-unreviewed-form-fact:identity.taxNumber'],
      remainingProof: ['authoritative-subcent-rounding'],
    };
    expect(() =>
      verifyTaxRun(
        {
          ...run,
          output: {
            ...run.output,
            formAudit: { ...run.output.formAudit, runHash: 'f'.repeat(64) },
          },
        },
        run.summary.runId,
        fixture.detail,
      ),
    ).toThrow('could not be verified');
    render(<FinanceTaxWorkspace />);
    await openWorking();
    await openFirstRun();
    const panel = screen.getByRole('region', { name: 'Required form data' });
    expect(
      within(panel).getByText(/1 required inputs are missing/),
    ).toBeInTheDocument();
    expect(
      within(panel).getByText(/Taxpayer signature and date remain manual/),
    ).toBeInTheDocument();
    expect(
      within(panel).getByText(/Personal: tax Number: Missing or unreviewed/),
    ).toBeInTheDocument();
  });

  it('binds input reviews to the exact current source revisions without changing raw declaration review state', () => {
    const fixture = taxWorkingFixture();
    fixture.approveInputs();
    const prepared = verifyTaxPreparation(
      fixture.preparation(),
      fixture.detail,
    );
    expect(
      taxWorkingInputs(prepared, fixture.detail).every(
        (input) => !!input.review,
      ),
    ).toBe(true);
    expect(
      fixture.detail.declaredInputs.every(
        (input) => input.reviewState === 'unreviewed',
      ),
    ).toBe(true);
    const changed = structuredClone(fixture.detail);
    changed.declaredInputs[0]!.sourceRevision++;
    expect(() => verifyTaxPreparation(prepared, changed)).toThrow(
      'current saved inputs',
    );
    expect(() =>
      verifyTaxPreparation(
        { ...prepared, snapshotHash: 'f'.repeat(64) },
        fixture.detail,
      ),
    ).toThrow('current saved inputs');
  });
  it('rejects a cross-case run, mismatched source approval and corrupt export bytes', async () => {
    const fixture = taxWorkingFixture();
    fixture.approveInputs();
    const run = fixture.createRun();
    fixture.reviewRun(run);
    expect(run.summary.status).toBe('incomplete-working-papers');
    expect(
      verifyTaxRun(run, run.summary.runId, fixture.detail).summary.complete,
    ).toBe(false);
    const foreign = structuredClone(run);
    foreign.summary.caseId = '72000000-0000-4000-8000-000000000001';
    expect(() =>
      verifyTaxRun(foreign, run.summary.runId, fixture.detail),
    ).toThrow('could not be verified');
    const invalid = structuredClone(run);
    invalid.inputBinding.inputReviews[0]!.contentHash = 'f'.repeat(64);
    expect(() =>
      verifyTaxRun(invalid, run.summary.runId, fixture.detail),
    ).toThrow('could not be verified');
    const file = fixture.exportRun(run);
    await expect(
      verifyTaxExport(file, run, file.reviewId),
    ).resolves.toMatchObject({ complete: false });
    await expect(
      verifyTaxExport(
        { ...file, content: `${file.content}changed` },
        run,
        file.reviewId,
      ),
    ).rejects.toThrow('No file was downloaded');
    await expect(
      verifyTaxExport(
        { ...file, snapshotHash: 'f'.repeat(64) },
        run,
        file.reviewId,
      ),
    ).rejects.toThrow('could not be verified');
  });
  it('requires exact-version selection and explicit review before posting current snapshot/package bindings', async () => {
    const fixture = setup();
    render(<FinanceTaxWorkspace />);
    await openWorking();
    const first = fixture.detail.declaredInputs[0]!;
    const question = fixture.preparation().questions[0]!;
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: `Review saved version: ${question.label}`,
      }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Review selected input versions' }),
    );
    expect(fixture.writes).toHaveLength(0);
    const confirmation = screen.getByRole('region', {
      name: 'Confirm exact input review',
    });
    expect(
      within(confirmation).getByText(first.contentHash),
    ).toBeInTheDocument();
    expect(
      within(confirmation).getByRole('button', {
        name: 'Approve exact input versions',
      }),
    ).toBeDisabled();
    fireEvent.click(within(confirmation).getByRole('checkbox'));
    fireEvent.click(
      within(confirmation).getByRole('button', {
        name: 'Approve exact input versions',
      }),
    );
    await waitFor(() => expect(fixture.writes).toHaveLength(1));
    expect(fixture.writes[0]!.body).toEqual({
      expectedCaseRevision: 2,
      expectedSnapshotHash: fixture.detail.snapshotHash,
      workflowId: 'ca-on-2025-personal-working-papers',
      expectedPackageVersion: fixture.preparation().packageVersion,
      inputs: [
        {
          sourceId: first.sourceId,
          sourceRevision: 1,
          contentHash: first.contentHash,
        },
      ],
    });
    await screen.findByText(
      'Exact input versions reviewed for this questionnaire revision and working-paper package.',
    );
    expect(fixture.detail.declaredInputs[0]!.reviewState).toBe('unreviewed');
  });
  it('saves a private identity prompt through the existing unreviewed declaration flow', async () => {
    const fixture = setup('preparer');
    vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
      const response = await fixture.fetcher(path, init);
      if (path.endsWith('/working-papers') && !init?.method) {
        const body = await response.json();
        body.questions.push({
          key: 'identity.firstName',
          label: 'Personal: first name',
          type: 'text',
          required: true,
          locator: 'T1 identification first name',
        });
        return new Response(JSON.stringify(body), { status: response.status });
      }
      return response;
    });
    render(<FinanceTaxWorkspace />);
    await openWorking();
    fireEvent.change(screen.getByLabelText('Show inputs'), {
      target: { value: 'all' },
    });
    fireEvent.click(screen.getByText('Personal details'));
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Add working input: Personal: first name',
      }),
    );
    fireEvent.change(screen.getByLabelText(/^Declaration value/u), {
      target: { value: 'Synthetic Private Name' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Review input$/u }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Save unreviewed input' }),
    );
    await waitFor(() => expect(fixture.writes).toHaveLength(1));
    expect(fixture.writes[0]!.body).toMatchObject({
      factKey: 'identity.firstName',
      expectedCaseRevision: 2,
      expectedSourceRevision: null,
      value: { type: 'text', value: 'Synthetic Private Name' },
    });
    expect(fixture.writes[0]!.body).not.toHaveProperty('reviewState');
  });
  it('saves a guided exact decimal under the canonical prompt and invalidates snapshot input approvals', async () => {
    const fixture = setup('preparer');
    const boundInput = fixture.detail.declaredInputs.find(
      (input) => input.factKey === 't4.box14',
    )!;
    fixture.declarations.unshift({
      ...boundInput,
      sourceId: '72000000-0000-4000-8000-000000000099',
      sourceRevision: 8,
      value: { type: 'decimal', value: '999999.00' },
    });
    fixture.approveInputs();
    render(<FinanceTaxWorkspace />);
    await openWorking();
    fireEvent.change(screen.getByLabelText('Show inputs'), {
      target: { value: 'all' },
    });
    fireEvent.click(screen.getByText('Employment & other income'));
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Revise working input: Employment income',
      }),
    );
    fireEvent.change(screen.getByLabelText(/^Declaration value/u), {
      target: { value: '50000.20' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Review input$/u }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Save unreviewed input' }),
    );
    await waitFor(() => expect(fixture.writes).toHaveLength(1));
    expect(fixture.writes[0]!.body).toMatchObject({
      expectedCaseRevision: 2,
      expectedSourceRevision: 1,
      sourceId: boundInput.sourceId,
      factKey: 't4.box14',
      value: { type: 'decimal', value: '50000.20' },
    });
    await screen.findByText('for revision 3');
    expect(fixture.preparation().inputReviews).toHaveLength(0);
    expect(
      screen.queryByRole('button', { name: 'Review selected input versions' }),
    ).not.toBeInTheDocument();
  });
  it('preserves input blockers in a new exact-bound run and offers no output approval or export', async () => {
    const fixture = setup('preparer');
    render(<FinanceTaxWorkspace />);
    await openWorking();
    fireEvent.click(
      screen.getByRole('button', { name: 'Review run creation' }),
    );
    const confirmation = screen.getByRole('region', {
      name: 'Confirm working-paper run',
    });
    fireEvent.click(within(confirmation).getByRole('checkbox'));
    fireEvent.click(
      within(confirmation).getByRole('button', {
        name: 'Create working-paper run',
      }),
    );
    await screen.findByRole('region', { name: 'Run input blockers' });
    expect(fixture.writes).toHaveLength(1);
    expect(fixture.writes[0]!.path).toBe(
      `/api/v2/finance/tax/cases/${taxCaseId}/runs`,
    );
    expect(fixture.writes[0]!.body).not.toHaveProperty('inputs');
    expect(fixture.runs[0]!.summary).toMatchObject({
      snapshotRevision: 2,
      status: 'blocked-input',
      complete: false,
    });
    expect(
      screen.queryByRole('button', {
        name: 'Review incomplete working papers',
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', {
        name: 'Download incomplete working papers (CSV)',
      }),
    ).not.toBeInTheDocument();
  });
  it('reviews the exact saved output and downloads only a freshly authorized, hash-verified incomplete CSV', async () => {
    const fixture = setup('reviewer');
    fixture.approveInputs();
    const run = fixture.createRun();
    render(<FinanceTaxWorkspace />);
    await openWorking();
    expect(
      screen.queryByRole('button', { name: 'Review run creation' }),
    ).not.toBeInTheDocument();
    await openFirstRun();
    expect(screen.getAllByText('50000.00').length).toBeGreaterThan(0);
    fireEvent.click(
      screen.getByRole('button', { name: 'Review incomplete working papers' }),
    );
    const confirmation = screen.getByRole('region', {
      name: 'Confirm incomplete working-paper review',
    });
    expect(
      within(confirmation).getByText(run.summary.outputHash),
    ).toBeInTheDocument();
    fireEvent.click(within(confirmation).getByRole('checkbox'));
    fireEvent.click(
      within(confirmation).getByRole('button', {
        name: 'Save incomplete working-paper review',
      }),
    );
    const download = await screen.findByRole('button', {
      name: 'Download incomplete working papers (CSV)',
    });
    expect(fixture.writes[0]!.body).toEqual({
      expectedOutputHash: run.summary.outputHash,
      acknowledgement: 'reviewed-incomplete-working-papers-not-fileable',
    });
    fireEvent.click(download);
    await waitFor(() => expect(saveMemoryFile).toHaveBeenCalledTimes(1));
    expect(vi.mocked(saveMemoryFile).mock.calls[0]![1]).toContain(
      'Private incomplete working papers; NOT FILEABLE',
    );
    expect(
      fixture.fetcher.mock.calls.some(([path]) =>
        path.endsWith(`/export?reviewId=${run.reviews[0]!.reviewId}`),
      ),
    ).toBe(true);
  });
  it('clears private run fields when source access changes before export and offers case refresh recovery', async () => {
    const fixture = setup('viewer');
    fixture.approveInputs();
    fixture.reviewRun(fixture.createRun());
    render(<FinanceTaxWorkspace />);
    await openWorking();
    expect(
      screen.queryByRole('button', { name: 'Review selected input versions' }),
    ).not.toBeInTheDocument();
    await openFirstRun();
    fixture.state.exportStatus = 403;
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Download incomplete working papers (CSV)',
      }),
    );
    await screen.findByText(/Refresh the tax case to check current access/u);
    expect(
      screen.queryByRole('region', { name: 'Exact working-paper fields' }),
    ).not.toBeInTheDocument();
    expect(saveMemoryFile).not.toHaveBeenCalled();
  });
  it('aborts a late export across a session change without downloading private bytes', async () => {
    const fixture = setup('viewer');
    fixture.approveInputs();
    const run = fixture.createRun();
    fixture.reviewRun(run);
    const original = fixture.fetcher.getMockImplementation()!;
    let finish: (() => void) | undefined;
    let signal: AbortSignal | null | undefined;
    fixture.fetcher.mockImplementation((path, init) =>
      path.includes('/export?')
        ? new Promise((resolve) => {
            signal = init?.signal;
            finish = () =>
              resolve(new Response(JSON.stringify(fixture.exportRun(run))));
          })
        : original(path, init),
    );
    const view = render(<FinanceTaxWorkspace />);
    await openWorking();
    await openFirstRun();
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Download incomplete working papers (CSV)',
      }),
    );
    await waitFor(() => expect(finish).toBeDefined());
    auth.state = 'anonymous';
    view.rerender(<FinanceTaxWorkspace />);
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      finish!();
    });
    expect(saveMemoryFile).not.toHaveBeenCalled();
  });
  it('keeps unsupported scopes and service failures distinct from empty run history', async () => {
    const fixture = setup();
    fixture.state.scopeSupported = false;
    render(<FinanceTaxWorkspace />);
    await openWorking();
    expect(
      screen.getByRole('region', { name: 'Unsupported working-paper scope' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Review run creation' }),
    ).toBeDisabled();
    expect(
      screen.queryByRole('checkbox', { name: /Review saved version/u }),
    ).not.toBeInTheDocument();
    fixture.state.status = 503;
    fireEvent.click(
      screen.getByRole('button', { name: 'Refresh working papers' }),
    );
    await screen.findByText(
      'Private tax preparation is not available right now.',
    );
    expect(screen.queryByText('No saved runs')).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText('Working-paper input progress'),
    ).not.toBeInTheDocument();
  });
});
