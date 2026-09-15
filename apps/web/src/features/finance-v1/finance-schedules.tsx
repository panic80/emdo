import { useEffect, useRef, useState, type FormEvent } from 'react';
import type {
  FinanceAutomationGrant,
  FinanceAutomationPlanningIntent,
} from '@emdo/contracts/browser';
import { Button } from '../../components/button.js';
import {
  ScheduleDraftSchema,
  ScheduleRequestError,
  readSchedules,
  readScheduleSources,
  prepareScheduleSource,
  type PreparedScheduleSource,
  type ScheduleSourceOption,
  createSchedule,
  changeScheduleState,
  type ScheduleDraft,
  type ScheduleRecord,
} from './finance-schedule-api.js';

type Fields = {
  grant: string;
  operation: 'report' | 'planning' | 'extraction' | 'journal';
  sourceOption?: string;
  planningOption: string;
  kind: 'interval' | 'daily' | 'weekly' | 'monthly';
  every: string;
  zone: string;
  time: string;
  anchor: string;
  day: string;
  short: 'skip' | 'last-day';
  gap: 'skip' | 'shift-forward';
  overlap: 'earlier' | 'later';
  start: string;
  end: string;
  misfire: 'skip' | 'coalesce-latest';
  lateness: string;
  concurrent: string;
};
const defaults = (): Fields => ({
  grant: '',
  operation: 'report',
  planningOption: '',
  sourceOption: '',
  kind: 'monthly',
  every: '1',
  zone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  time: '09:00',
  anchor: new Date().toISOString().slice(0, 10),
  day: '1',
  short: 'last-day',
  gap: 'skip',
  overlap: 'earlier',
  start: new Date().toISOString(),
  end: '',
  misfire: 'coalesce-latest',
  lateness: '3600',
  concurrent: '1',
});
export function scheduleDraft(
  fields: Fields,
  grant: FinanceAutomationGrant,
  bookId: string,
  tzdbVersion: string,
  planning?: FinanceAutomationPlanningIntent,
  source?: PreparedScheduleSource,
): ScheduleDraft {
  if (
    (fields.operation === 'extraction' || fields.operation === 'journal') &&
    source?.kind !== fields.operation
  )
    throw new Error('Prepare and review the selected source before saving.');
  if (fields.operation === 'planning' && !planning)
    throw new Error('Choose a saved planning revision.');
  if (source && source.kind !== fields.operation)
    throw new Error('Prepared source does not match the selected operation.');
  const every = Number(fields.every),
    local = {
      timeZone: fields.zone,
      localTime: fields.time.length === 5 ? `${fields.time}:00` : fields.time,
      gapPolicy: fields.gap,
      overlapPolicy: fields.overlap,
      tzdbVersion,
    };
  const cadence =
    fields.kind === 'interval'
      ? {
          kind: 'interval',
          everySeconds: every * 60,
          timeZone: fields.zone,
          clock: 'elapsed-utc',
        }
      : fields.kind === 'daily'
        ? {
            kind: 'daily',
            anchorDate: fields.anchor,
            everyDays: every,
            ...local,
          }
        : fields.kind === 'weekly'
          ? {
              kind: 'weekly',
              anchorDate: fields.anchor,
              weekday:
                ((new Date(`${fields.anchor}T12:00:00Z`).getUTCDay() + 6) % 7) +
                1,
              everyWeeks: every,
              ...local,
            }
          : {
              kind: 'monthly',
              anchorMonth: fields.anchor.slice(0, 7),
              dayOfMonth: Number(fields.day),
              everyMonths: every,
              shortMonthPolicy: fields.short,
              ...local,
            };
  const draft = ScheduleDraftSchema.parse({
    grantId: grant.id,
    grantRevision: grant.revision,
    capability:
      source?.kind === 'extraction'
        ? 'finance.documents.extract'
        : source?.kind === 'journal'
          ? 'finance.journals.draft'
          : (planning?.capability ?? 'finance.reports.generate'),
    targets:
      source?.kind === 'extraction'
        ? [source.extraction.evidenceId]
        : source?.kind === 'journal'
          ? [source.journal.batchId]
          : planning
            ? [planning.budgetId]
            : [bookId],
    ...(planning ? { planning } : {}),
    ...(source?.kind === 'extraction'
      ? { extraction: source.extraction }
      : source?.kind === 'journal'
        ? { journal: source.journal }
        : {}),
    money: {
      currency:
        source?.money.currency ?? planning?.currency ?? grant.limits.currency,
      amount: source?.money.amount ?? '0',
    },
    startAt: fields.start,
    endAt: fields.end || null,
    cadence,
    misfire:
      fields.misfire === 'skip'
        ? { policy: 'skip', graceSeconds: Number(fields.lateness) }
        : {
            policy: 'coalesce-latest',
            maxLatenessSeconds: Number(fields.lateness),
          },
    concurrency:
      Number(fields.concurrent) === 1
        ? { policy: 'forbid', onBusy: 'defer' }
        : {
            policy: 'allow',
            maxInFlight: Number(fields.concurrent),
            onBusy: 'defer',
          },
  });
  if (
    !Number.isFinite(Date.parse(draft.startAt)) ||
    Date.parse(draft.startAt) < Date.parse(grant.validFrom) ||
    Date.parse(draft.startAt) >= Date.parse(grant.expiresAt) ||
    (draft.endAt &&
      (Date.parse(draft.endAt) <= Date.parse(draft.startAt) ||
        Date.parse(draft.endAt) > Date.parse(grant.expiresAt)))
  )
    throw new Error(
      'Use a start and end inside the selected grant’s validity window.',
    );
  if (planning && !grant.allowedCapabilities.includes(planning.capability))
    throw new Error(
      'The selected grant does not authorize this planning workflow.',
    );
  if (planning && grant.limits.currency !== planning.currency)
    throw new Error(
      'The selected grant currency does not match the planning book.',
    );
  if (
    !grant.allowedCapabilities.includes(draft.capability) ||
    grant.limits.currency !== draft.money.currency
  )
    throw new Error(
      'The selected grant does not match this prepared workflow or currency.',
    );
  return draft;
}
function editFields(row: ScheduleRecord): Fields {
  const d = row.schedule.definition,
    c = d.cadence,
    f = defaults();
  return {
    ...f,
    grant: d.grantId,
    operation: d.extraction
      ? 'extraction'
      : d.journal
        ? 'journal'
        : d.planning
          ? 'planning'
          : 'report',
    sourceOption: d.extraction?.evidenceId ?? d.journal?.batchId ?? '',
    planningOption: '',
    kind: c.kind,
    every: String(
      c.kind === 'interval'
        ? c.everySeconds / 60
        : c.kind === 'daily'
          ? c.everyDays
          : c.kind === 'weekly'
            ? c.everyWeeks
            : c.everyMonths,
    ),
    zone: c.timeZone,
    start: d.startAt,
    end: d.endAt ?? '',
    misfire: d.misfire.policy,
    lateness: String(
      d.misfire.policy === 'skip'
        ? d.misfire.graceSeconds
        : d.misfire.maxLatenessSeconds,
    ),
    concurrent: String(
      d.concurrency.policy === 'forbid' ? 1 : d.concurrency.maxInFlight,
    ),
    ...(c.kind !== 'interval'
      ? {
          time: c.localTime,
          anchor: c.kind === 'monthly' ? `${c.anchorMonth}-01` : c.anchorDate,
          gap: c.gapPolicy,
          overlap: c.overlapPolicy,
        }
      : {}),
    ...(c.kind === 'monthly'
      ? { day: String(c.dayOfMonth), short: c.shortMonthPolicy }
      : {}),
  };
}
function cadenceLabel(row: ScheduleRecord) {
  const c = row.schedule.definition.cadence;
  return c.kind === 'interval'
    ? `Every ${c.everySeconds / 60} minutes · elapsed UTC`
    : `${c.kind === 'monthly' ? `Every ${c.everyMonths} month(s), day ${c.dayOfMonth}` : c.kind === 'weekly' ? `Every ${c.everyWeeks} week(s), ${['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][c.weekday - 1]}` : `Every ${c.everyDays} day(s)`} at ${c.localTime} · ${c.timeZone}`;
}

export type PlanningScheduleOption = {
  id: string;
  label: string;
  capability: FinanceAutomationPlanningIntent['capability'];
};
export function FinanceSchedules({
  bookId,
  grants,
  csrfToken,
  planningOptions = [],
  resolvePlanningIntent,
  planningOnly = false,
}: {
  bookId: string;
  grants: FinanceAutomationGrant[] | undefined;
  csrfToken?: string;
  planningOptions?: readonly PlanningScheduleOption[];
  resolvePlanningIntent?: (
    option: PlanningScheduleOption,
  ) => Promise<FinanceAutomationPlanningIntent>;
  planningOnly?: boolean;
}) {
  const [rows, setRows] = useState<ScheduleRecord[]>(),
    [version, setVersion] = useState(''),
    [offset, setOffset] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [fields, setFields] = useState(defaults),
    [form, setForm] = useState(false),
    [replacement, setReplacement] = useState<string>(),
    [retiring, setRetiring] = useState<string>();
  const [sourceOptions, setSourceOptions] = useState<ScheduleSourceOption[]>(
      [],
    ),
    [sourceNextOffset, setSourceNextOffset] = useState<number | null>(null),
    [preparedSource, setPreparedSource] = useState<PreparedScheduleSource>(),
    [savedSourcePin, setSavedSourcePin] = useState<ScheduleRecord>();
  const alive = useRef(true),
    controller = useRef<AbortController | undefined>(undefined),
    working = useRef(false),
    keys = useRef(new Map<string, string>());
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      controller.current?.abort();
    };
  }, []);
  useEffect(() => {
    controller.current?.abort();
    controller.current = undefined;
    working.current = false;
    setBusy(false);
    setError('');
    setNotice('');
    setVersion('');
    setOffset(0);
    setReplacement(undefined);
    setRetiring(undefined);
    setSourceNextOffset(null);
    setRows(undefined);
    setForm(false);
    setFields(defaults());
    setSourceOptions([]);
    setPreparedSource(undefined);
    setSavedSourcePin(undefined);
    keys.current.clear();
  }, [bookId]);
  const eligible = (grants ?? []).filter(
    (g) =>
      g.status === 'active' &&
      g.bookId === bookId &&
      Date.parse(g.validFrom) <= Date.now() &&
      (planningOnly
        ? planningOptions.some((option) =>
            g.allowedCapabilities.includes(option.capability),
          )
        : [
            'finance.reports.generate',
            'finance.documents.extract',
            'finance.journals.draft',
          ].some((capability) =>
            g.allowedCapabilities.includes(
              capability as FinanceAutomationGrant['allowedCapabilities'][number],
            ),
          )) &&
      Date.parse(g.expiresAt) > Date.now(),
  );
  const set = <K extends keyof Fields>(key: K, value: Fields[K]) =>
    setFields((f) => ({ ...f, [key]: value }));
  async function perform(work: (signal: AbortSignal) => Promise<void>) {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError('');
    controller.current?.abort();
    const c = new AbortController();
    controller.current = c;
    try {
      await work(c.signal);
    } catch (cause) {
      if (alive.current && !c.signal.aborted) {
        setError(
          cause instanceof ScheduleRequestError
            ? cause.message
            : cause instanceof Error && cause.name !== 'ZodError'
              ? cause.message
              : 'Check the calendar fields, grant window and policy limits.',
        );
        if (
          cause instanceof ScheduleRequestError &&
          (cause.status === 401 || cause.status === 403 || cause.status === 503)
        ) {
          setRows(undefined);
          setForm(false);
          setPreparedSource(undefined);
          setSavedSourcePin(undefined);
          setSourceOptions([]);
          keys.current.clear();
        }
      }
    } finally {
      if (controller.current === c) {
        working.current = false;
        if (alive.current && !c.signal.aborted) setBusy(false);
      }
    }
  }
  const load = (page: number) =>
    perform(async (signal) => {
      const result = await readSchedules(bookId, page, signal);
      if (!alive.current || signal.aborted) return;
      setRows(
        planningOnly
          ? result.records.filter((row) => row.schedule.definition.planning)
          : result.records,
      );
      setVersion(result.tzdbVersion);
      setOffset(page);
      setNotice('');
    });
  function loadSourceOptions(page = 0) {
    if (fields.operation !== 'extraction' && fields.operation !== 'journal')
      return;
    const operation = fields.operation;
    void perform(async (signal) => {
      const result = await readScheduleSources(bookId, operation, page, signal);
      if (!alive.current || signal.aborted) return;
      setSourceOptions((previous) =>
        page ? [...previous, ...result.options] : result.options,
      );
      setSourceNextOffset(result.nextOffset);
    });
  }
  function prepareSource() {
    const option = sourceOptions.find(
        (source) =>
          source.id === fields.sourceOption && source.kind === fields.operation,
      ),
      grant = eligible.find((item) => item.id === fields.grant);
    if (!option || !grant || !csrfToken) {
      setError('Choose a saved source and an eligible grant before preparing.');
      return;
    }
    setPreparedSource(undefined);
    const signature = JSON.stringify([
        'prepare-source',
        option,
        grant.limits.currency,
      ]),
      key = keys.current.get(signature) ?? crypto.randomUUID();
    keys.current.set(signature, key);
    void perform(async (signal) => {
      const result = await prepareScheduleSource(
        bookId,
        option,
        grant.limits.currency,
        csrfToken,
        key,
        signal,
      );
      if (!alive.current || signal.aborted) return;
      setPreparedSource(result);
      keys.current.delete(signature);
    });
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!csrfToken) return;
    const grant = eligible.find((g) => g.id === fields.grant);
    if (!grant) {
      setError(
        planningOnly
          ? 'Choose an active planning grant that you issued.'
          : 'Choose an active workflow grant that you issued.',
      );
      return;
    }
    let draft: ScheduleDraft;
    try {
      const option = planningOnly
        ? planningOptions.find((value) => value.id === fields.planningOption)
        : undefined;
      const planning = option
        ? await resolvePlanningIntent?.(option)
        : undefined;
      if (planningOnly && (!option || !planning))
        throw new Error('Choose a saved planning revision before saving.');
      draft = scheduleDraft(
        fields,
        grant,
        bookId,
        version,
        planning,
        preparedSource,
      );
    } catch (cause) {
      setError(
        cause instanceof Error && cause.name !== 'ZodError'
          ? cause.message
          : 'Check the planning revision, calendar fields, grant window and policy limits.',
      );
      return;
    }
    const signature = JSON.stringify(draft),
      key = keys.current.get(signature) ?? crypto.randomUUID();
    keys.current.set(signature, key);
    await perform(async (signal) => {
      const result = await createSchedule(
        bookId,
        draft,
        csrfToken,
        key,
        signal,
      );
      if (!alive.current || signal.aborted) return;
      keys.current.delete(signature);
      setRows((previous) =>
        [
          result,
          ...(previous ?? []).filter(
            (r) => r.schedule.id !== result.schedule.id,
          ),
        ].slice(0, 20),
      );
      setForm(false);
      setNotice(
        replacement
          ? 'Replacement saved. The original remains paused or retired; its history is preserved.'
          : 'Schedule saved. Execution still requires current authority and an enabled worker.',
      );
      setReplacement(undefined);
    });
  }
  const change = (
    row: ScheduleRecord,
    status: 'active' | 'paused' | 'retired',
  ) => {
    if (!csrfToken) return;
    const signature = `${row.schedule.id}:${row.schedule.stateRevision}:${status}`,
      key = keys.current.get(signature) ?? crypto.randomUUID();
    keys.current.set(signature, key);
    void perform(async (signal) => {
      const result = await changeScheduleState(
        bookId,
        row,
        status,
        csrfToken,
        key,
        signal,
      );
      if (!alive.current || signal.aborted) return;
      keys.current.delete(signature);
      setRows((previous) =>
        previous?.map((r) =>
          r.schedule.id === result.schedule.id ? result : r,
        ),
      );
      setRetiring(undefined);
      setNotice(
        status === 'retired'
          ? 'Schedule retired permanently. Existing runs retain their separate grant checks.'
          : status === 'paused'
            ? 'Schedule paused. Future triggers are suspended.'
            : 'Schedule resumed, subject to current grant and execution readiness.',
      );
    });
  };
  return (
    <section
      className="finance-schedules"
      aria-label={
        planningOnly ? 'Recurring planning schedules' : 'Recurring schedules'
      }
    >
      <div className="finance-automations__heading">
        <div>
          <span className="finance-automations__eyebrow">
            {planningOnly ? 'Recurring planning' : 'Recurring workflows'}
          </span>
          <h2>Schedules</h2>
          <p>
            {planningOnly
              ? 'Choose when EMDO should run a saved budget or reviewed forecast revision for this book.'
              : 'Choose when EMDO should prepare a report, extract a fixed saved document, or draft journals from a reviewed import.'}
          </p>
        </div>
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => void load(0)}
        >
          {rows ? 'Refresh schedules' : 'Load schedules'}
        </Button>
      </div>
      <p>
        Saving a schedule does not enable execution. Grant, entitlement and
        worker readiness are checked for every occurrence.
      </p>
      {error && <p role="alert">{error}</p>}
      <p aria-live="polite">
        {busy ? 'Loading schedule information…' : notice}
      </p>
      {rows && (
        <>
          <div className="finance-schedules__actions">
            <Button
              disabled={busy || !csrfToken || eligible.length === 0}
              onClick={() => {
                const option = planningOnly ? planningOptions[0] : undefined;
                const selectedGrant = option
                  ? eligible.find((value) =>
                      value.allowedCapabilities.includes(option.capability),
                    )
                  : eligible[0];
                setFields({
                  ...defaults(),
                  operation: planningOnly ? 'planning' : 'report',
                  planningOption: option?.id ?? '',
                  grant: selectedGrant?.id ?? '',
                });
                setReplacement(undefined);
                setPreparedSource(undefined);
                setSavedSourcePin(undefined);
                setSourceOptions([]);
                setForm(true);
              }}
            >
              {planningOnly
                ? 'New planning schedule'
                : eligible.some((g) =>
                      g.allowedCapabilities.some(
                        (capability) =>
                          capability === 'finance.documents.extract' ||
                          capability === 'finance.journals.draft',
                      ),
                    )
                  ? 'New source or report schedule'
                  : 'New report schedule'}
            </Button>
            <span>
              {eligible.length === 0
                ? planningOnly
                  ? 'An active planning grant is required. Create a grant above to authorize these operations.'
                  : 'An active report, extraction or journal draft grant is required. Create a grant above to authorize these operations.'
                : 'Use a grant that you issued. The server checks current authority.'}
            </span>
          </div>
          {rows.length === 0 && <p>No schedules saved for this book.</p>}
          {rows.map((row) => (
            <article className="finance-grant" key={row.schedule.id}>
              <div className="finance-grant__heading">
                <div>
                  <h3>
                    {row.schedule.definition.capability ===
                    'finance.reports.generate'
                      ? 'Posted trial balance'
                      : row.schedule.definition.extraction
                        ? 'Fixed-document extraction'
                        : row.schedule.definition.journal
                          ? 'Reviewed-import journal drafts'
                          : row.schedule.definition.capability ===
                              'finance.planning.budget-vs-actuals'
                            ? 'Budget versus actuals'
                            : 'Reviewed forecast'}
                  </h3>
                  <p>{cadenceLabel(row)}</p>
                </div>
                <span className="finance-status">{row.schedule.status}</span>
              </div>
              <p>
                Next planned time:{' '}
                {row.nextDueAt ?? 'No next occurrence currently planned'}
              </p>
              {row.blockedReason && (
                <p>
                  Waiting:{' '}
                  {/^(finance-journal-|extraction-source-)/.test(
                    row.blockedReason,
                  )
                    ? 'The saved source no longer matches this schedule. Review the source and create a replacement before continuing.'
                    : row.blockedReason}
                </p>
              )}
              {(row.schedule.definition.extraction ||
                row.schedule.definition.journal) && (
                <p style={{ overflowWrap: 'anywhere' }}>
                  {row.schedule.definition.extraction
                    ? `Fixed document ${row.schedule.definition.extraction.evidenceId} · extraction revision ${row.schedule.definition.extraction.expectedExtractionRevision}`
                    : `Reviewed import ${row.schedule.definition.journal!.batchId} · revision ${row.schedule.definition.journal!.expectedBatchRevision}`}{' '}
                  · {row.schedule.definition.money.amount}{' '}
                  {row.schedule.definition.money.currency}. Changed sources
                  require re-review. Journal posting is never scheduled.
                </p>
              )}
              <details>
                <summary>Schedule policies and history reference</summary>
                <p>
                  Reference: {row.schedule.id} · state revision{' '}
                  {row.schedule.stateRevision}
                </p>
                <p>
                  Start: {row.schedule.definition.startAt} · End:{' '}
                  {row.schedule.definition.endAt ??
                    'Grant expiry limits execution'}
                </p>
                <p>
                  Missed occurrences: {row.schedule.definition.misfire.policy}.
                  Maximum concurrent runs:{' '}
                  {row.schedule.definition.concurrency.policy === 'forbid'
                    ? 1
                    : row.schedule.definition.concurrency.maxInFlight}
                  . Busy and unknown outcomes defer the next trigger.
                </p>
                {row.schedule.definition.cadence.kind !== 'interval' && (
                  <p>
                    Clock gap: {row.schedule.definition.cadence.gapPolicy};
                    clock overlap:{' '}
                    {row.schedule.definition.cadence.overlapPolicy}.
                    {row.schedule.definition.cadence.kind === 'monthly'
                      ? ` Short month: ${row.schedule.definition.cadence.shortMonthPolicy}.`
                      : ''}
                  </p>
                )}
              </details>
              <div className="finance-schedules__actions">
                {row.schedule.status !== 'retired' && (
                  <>
                    <Button
                      variant="secondary"
                      disabled={busy || !csrfToken}
                      onClick={() =>
                        change(
                          row,
                          row.schedule.status === 'active'
                            ? 'paused'
                            : 'active',
                        )
                      }
                    >
                      {row.schedule.status === 'active'
                        ? 'Pause schedule'
                        : 'Resume schedule'}
                    </Button>
                    <Button
                      variant="quiet"
                      disabled={busy || !csrfToken}
                      onClick={() => setRetiring(row.schedule.id)}
                    >
                      Retire schedule
                    </Button>
                  </>
                )}
                {row.schedule.status !== 'active' &&
                  [
                    'finance.reports.generate',
                    'finance.documents.extract',
                    'finance.journals.draft',
                  ].includes(row.schedule.definition.capability) && (
                    <Button
                      variant="quiet"
                      disabled={busy || !csrfToken}
                      onClick={() => {
                        setFields(editFields(row));
                        setPreparedSource(undefined);
                        setSourceOptions([]);
                        setSavedSourcePin(row);
                        setReplacement(row.schedule.id);
                        setForm(true);
                      }}
                    >
                      Edit as replacement
                    </Button>
                  )}
              </div>
              {row.schedule.status === 'active' && (
                <p>
                  Pause before editing. Replacements preserve the original
                  schedule and its history.
                </p>
              )}
              {retiring === row.schedule.id && (
                <div role="group" aria-label="Confirm schedule retirement">
                  <p>
                    Retire permanently? This stops future triggers. Existing
                    runs are controlled by their grant.
                  </p>
                  <Button
                    disabled={busy}
                    onClick={() => change(row, 'retired')}
                  >
                    Confirm retirement
                  </Button>
                  <Button
                    variant="quiet"
                    disabled={busy}
                    onClick={() => setRetiring(undefined)}
                  >
                    Cancel retirement
                  </Button>
                </div>
              )}
            </article>
          ))}
          <div className="finance-schedules__actions">
            <Button
              variant="quiet"
              disabled={busy || offset === 0}
              onClick={() => void load(Math.max(0, offset - 20))}
            >
              Previous schedules
            </Button>
            <Button
              variant="quiet"
              disabled={busy || rows.length < 20}
              onClick={() => void load(offset + 20)}
            >
              Next schedules
            </Button>
          </div>
        </>
      )}
      {form && (
        <form
          className="finance-schedules__form"
          onSubmit={(event) => void save(event)}
        >
          <h3>
            {replacement
              ? 'Create replacement schedule'
              : planningOnly
                ? 'New planning schedule'
                : 'New posted trial-balance schedule'}
          </h3>
          <p>
            One latest occurrence is considered per check. Earlier missed
            occurrences are recorded as skipped or coalesced, never launched as
            an unlimited backlog.
          </p>
          <fieldset disabled={busy}>
            <legend>Authority and timing</legend>
            {!planningOnly && (
              <label>
                Scheduled operation
                <select
                  value={fields.operation}
                  onChange={(event) => {
                    const operation = event.target.value as Fields['operation'];
                    set('operation', operation);
                    set('sourceOption', '');
                    setSourceOptions([]);
                    setSourceNextOffset(null);
                    setPreparedSource(undefined);
                    const capability =
                      operation === 'extraction'
                        ? 'finance.documents.extract'
                        : operation === 'journal'
                          ? 'finance.journals.draft'
                          : 'finance.reports.generate';
                    set(
                      'grant',
                      eligible.find((grant) =>
                        grant.allowedCapabilities.includes(capability),
                      )?.id ?? '',
                    );
                  }}
                >
                  <option value="report">Posted trial balance</option>
                  <option value="extraction">
                    Extract a fixed saved document
                  </option>
                  <option value="journal">
                    Draft journals from a reviewed import
                  </option>
                </select>
              </label>
            )}
            <label>
              {planningOnly
                ? 'Planning grant'
                : fields.operation === 'report'
                  ? 'Report grant'
                  : 'Source workflow grant'}
              <select
                value={fields.grant}
                onChange={(e) => {
                  set('grant', e.target.value);
                  setPreparedSource(undefined);
                }}
                required
              >
                <option value="">Choose a grant you issued</option>
                {eligible.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.id} · expires {g.expiresAt}
                  </option>
                ))}
              </select>
            </label>
            {(fields.operation === 'extraction' ||
              fields.operation === 'journal') && (
              <section aria-label="Scheduled source review">
                <p>
                  {fields.operation === 'extraction'
                    ? 'This schedule pins one fixed document and the prepared extraction revision. It does not watch for or ingest new documents.'
                    : 'This schedule uses one reviewed import revision to create journal drafts. Approval and posting remain separate decisions.'}{' '}
                  Source changes require explicit re-review and a replacement
                  schedule.
                </p>
                {savedSourcePin && (
                  <p style={{ overflowWrap: 'anywhere' }}>
                    Saved pin:{' '}
                    {savedSourcePin.schedule.definition.extraction
                      ? `document ${savedSourcePin.schedule.definition.extraction.evidenceId}; extraction revision ${savedSourcePin.schedule.definition.extraction.expectedExtractionRevision}; source ${savedSourcePin.schedule.definition.extraction.expectedSourceDigest}`
                      : savedSourcePin.schedule.definition.journal
                        ? `import ${savedSourcePin.schedule.definition.journal.batchId}; revision ${savedSourcePin.schedule.definition.journal.expectedBatchRevision}; snapshot ${savedSourcePin.schedule.definition.journal.expectedSnapshotHash}`
                        : ''}
                    . Prepare the source again before saving a replacement.
                  </p>
                )}
                <Button type="button" onClick={() => loadSourceOptions()}>
                  Load saved source choices
                </Button>
                <label>
                  {fields.operation === 'extraction'
                    ? 'Saved document'
                    : 'Reviewed source import'}
                  <select
                    value={fields.sourceOption ?? ''}
                    onChange={(event) => {
                      set('sourceOption', event.target.value);
                      setPreparedSource(undefined);
                    }}
                    required
                  >
                    <option value="">Choose a saved source</option>
                    {sourceOptions.map((source) => (
                      <option key={source.id} value={source.id}>
                        {source.label}
                        {source.revision
                          ? ` · revision ${source.revision}`
                          : ''}
                      </option>
                    ))}
                  </select>
                </label>
                {sourceNextOffset !== null && (
                  <Button
                    type="button"
                    onClick={() => loadSourceOptions(sourceNextOffset)}
                  >
                    Load more sources
                  </Button>
                )}
                <Button
                  type="button"
                  disabled={!fields.sourceOption || !fields.grant}
                  onClick={prepareSource}
                >
                  Prepare scheduled source
                </Button>
                {preparedSource && (
                  <div aria-label="Prepared schedule source">
                    <h4>Review the prepared source</h4>
                    <p>
                      {preparedSource.label} · {preparedSource.itemCount}{' '}
                      {preparedSource.kind === 'journal'
                        ? 'proposed journal lines'
                        : 'document'}{' '}
                      · {preparedSource.money.amount}{' '}
                      {preparedSource.money.currency}
                    </p>
                    <p style={{ overflowWrap: 'anywhere' }}>
                      {preparedSource.kind === 'journal'
                        ? `Import revision ${preparedSource.journal.expectedBatchRevision}; snapshot ${preparedSource.journal.expectedSnapshotHash}`
                        : `Extraction revision ${preparedSource.extraction.expectedExtractionRevision}; source ${preparedSource.extraction.expectedSourceDigest}`}
                    </p>
                    <p>
                      Source scope and amounts above come from saved
                      preparation. They are not refreshed automatically.
                    </p>
                  </div>
                )}
              </section>
            )}
            {planningOnly && (
              <label>
                Planning revision
                <select
                  value={fields.planningOption}
                  onChange={(e) => {
                    const option = planningOptions.find(
                      (value) => value.id === e.target.value,
                    );
                    set('planningOption', e.target.value);
                    if (option) {
                      const matchingGrant = eligible.find((value) =>
                        value.allowedCapabilities.includes(option.capability),
                      );
                      if (matchingGrant) set('grant', matchingGrant.id);
                    }
                  }}
                  required
                >
                  <option value="">Choose a saved revision</option>
                  {planningOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              Cadence
              <select
                value={fields.kind}
                onChange={(e) => set('kind', e.target.value as Fields['kind'])}
              >
                <option value="monthly">Monthly</option>
                <option value="weekly">Weekly</option>
                <option value="daily">Daily</option>
                <option value="interval">Elapsed interval</option>
              </select>
            </label>
            <label>
              Every (
              {fields.kind === 'interval'
                ? 'minutes'
                : fields.kind === 'monthly'
                  ? 'months'
                  : fields.kind === 'weekly'
                    ? 'weeks'
                    : 'days'}
              )
              <input
                required
                type="number"
                min="1"
                step="1"
                value={fields.every}
                onChange={(e) => set('every', e.target.value)}
              />
            </label>
            <label>
              IANA time zone
              <input
                required
                value={fields.zone}
                onChange={(e) => set('zone', e.target.value)}
                placeholder="America/Toronto"
              />
            </label>
            {fields.kind !== 'interval' && (
              <>
                <label>
                  {fields.kind === 'monthly'
                    ? 'First month (choose any date in it)'
                    : fields.kind === 'weekly'
                      ? 'First weekly date (sets the weekday)'
                      : 'First daily date'}
                  <input
                    required
                    type="date"
                    value={fields.anchor}
                    onChange={(e) => set('anchor', e.target.value)}
                  />
                </label>
                <label>
                  Local time
                  <input
                    required
                    type="time"
                    step="1"
                    value={fields.time}
                    onChange={(e) => set('time', e.target.value)}
                  />
                </label>
                <label>
                  When the clock skips this time
                  <select
                    value={fields.gap}
                    onChange={(e) =>
                      set('gap', e.target.value as Fields['gap'])
                    }
                  >
                    <option value="skip">Skip that occurrence</option>
                    <option value="shift-forward">
                      Shift forward by the clock gap
                    </option>
                  </select>
                </label>
                <label>
                  When the clock repeats this time
                  <select
                    value={fields.overlap}
                    onChange={(e) =>
                      set('overlap', e.target.value as Fields['overlap'])
                    }
                  >
                    <option value="earlier">Use the earlier occurrence</option>
                    <option value="later">Use the later occurrence</option>
                  </select>
                </label>
              </>
            )}
            {fields.kind === 'monthly' && (
              <>
                <label>
                  Day of month
                  <input
                    required
                    type="number"
                    min="1"
                    max="31"
                    value={fields.day}
                    onChange={(e) => set('day', e.target.value)}
                  />
                </label>
                <label>
                  When that day is missing
                  <select
                    value={fields.short}
                    onChange={(e) =>
                      set('short', e.target.value as Fields['short'])
                    }
                  >
                    <option value="last-day">
                      Use the last day of the month
                    </option>
                    <option value="skip">Skip that month</option>
                  </select>
                </label>
              </>
            )}
            <label>
              Start instant (ISO date and UTC offset)
              <input
                required
                value={fields.start}
                onChange={(e) => set('start', e.target.value)}
                placeholder="2026-10-01T09:00:00-04:00"
              />
            </label>
            <label>
              End instant, optional (ISO date and UTC offset)
              <input
                value={fields.end}
                onChange={(e) => set('end', e.target.value)}
                placeholder="2027-01-01T00:00:00Z"
              />
            </label>
          </fieldset>
          <fieldset disabled={busy}>
            <legend>Missed and overlapping runs</legend>
            <label>
              Missed occurrence policy
              <select
                value={fields.misfire}
                onChange={(e) => {
                  set('misfire', e.target.value as Fields['misfire']);
                  set('lateness', e.target.value === 'skip' ? '60' : '3600');
                }}
              >
                <option value="coalesce-latest">
                  Run only the latest within the allowed delay
                </option>
                <option value="skip">
                  Skip missed runs beyond a short grace period
                </option>
              </select>
            </label>
            <label>
              {fields.misfire === 'skip' ? 'Grace period' : 'Maximum delay'}{' '}
              (seconds)
              <input
                required
                type="number"
                min="0"
                max={fields.misfire === 'skip' ? 300 : 86400}
                value={fields.lateness}
                onChange={(e) => set('lateness', e.target.value)}
              />
            </label>
            <label>
              Maximum concurrent runs
              <input
                required
                type="number"
                min="1"
                max="100"
                value={fields.concurrent}
                onChange={(e) => set('concurrent', e.target.value)}
              />
            </label>
            <p>
              When busy, defer without consuming the occurrence. An unknown
              result remains blocking until reconciled.
            </p>
          </fieldset>
          <div className="finance-schedules__actions">
            <Button type="submit" disabled={busy || !csrfToken}>
              {replacement ? 'Save replacement' : 'Save schedule'}
            </Button>
            <Button
              type="button"
              variant="quiet"
              disabled={busy}
              onClick={() => setForm(false)}
            >
              Cancel schedule changes
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
