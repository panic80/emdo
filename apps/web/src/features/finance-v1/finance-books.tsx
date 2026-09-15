import { FinanceLegacyMigrations } from './finance-legacy-migrations.js';
import { FinanceFec } from './finance-fec.js';
import { FinanceInvestments } from './finance-investments.js';
import { FinanceAutomations } from './finance-automations.js';
import { FinancePlanning } from './finance-planning.js';
import { FinanceTaxWorkspace } from './finance-tax-workspace.js';
import { FinanceGeneratedReports } from './finance-generated-reports.js';
import {
  FinanceReportMappings,
  type AnalyzeBookReport,
} from './finance-report-mappings.js';
import './finance-books.css';
import { FinanceBookDocuments } from './finance-book-documents.js';
import { FinanceCommercial } from './finance-commercial.js';
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type KeyboardEvent,
} from 'react';
import { z } from 'zod';
import {
  FinanceCurrencySchema,
  FinanceDecimalSchema,
  FinanceBookRoleSchema,
  UuidSchema,
} from '@emdo/contracts/browser';
import { Button } from '../../components/button.js';
import { useAuth } from '../auth/auth-context.js';
import { Icon } from '../../components/icon.js';
import { PageHeader } from '../../components/page.js';
import { financeCopy } from './finance-locales.js';
import type { FinanceLocale } from './finance-document-api.js';

const Book = z.object({
  id: UuidSchema,
  name: z.string(),
  entityName: z.string(),
  country: z.string(),
  functionalCurrency: FinanceCurrencySchema,
  role: FinanceBookRoleSchema,
});
const Row = z.object({
  id: UuidSchema,
  code: z.string(),
  name: z.string(),
  kind: z.string(),
  debit: FinanceDecimalSchema,
  credit: FinanceDecimalSchema,
  balance: FinanceDecimalSchema,
});
const Overview = z.object({
  trialBalance: z.array(Row),
  periods: z.array(
    z.object({
      id: UuidSchema,
      startsOn: z.string(),
      endsOn: z.string(),
      status: z.enum(['open', 'closed']),
    }),
  ),
  journals: z.array(
    z.object({
      id: UuidSchema,
      effectiveOn: z.string(),
      description: z.string(),
      sourceReference: z.string(),
      reversalOf: UuidSchema.nullable(),
    }),
  ),
});
type BookView = z.infer<typeof Book>;
type WorkspaceView =
  | 'overview'
  | 'books'
  | 'documents'
  | 'accounts'
  | 'planning'
  | 'reports'
  | 'automations'
  | 'activity';
const views: readonly WorkspaceView[] = [
  'overview',
  'books',
  'documents',
  'accounts',
  'planning',
  'reports',
  'automations',
  'activity',
];
const additionalLabels = {
  'en-CA': {
    books: 'Books',
    accounts: 'Accounts & investments',
    reports: 'Reports & tax',
    automations: 'Automations',
  },
  'fr-CA': {
    books: 'Livres',
    accounts: 'Comptes et placements',
    reports: 'Rapports et impôts',
    automations: 'Automatisations',
  },
  'ja-JP': {
    books: '帳簿',
    accounts: '口座・投資',
    reports: 'レポート・税務',
    automations: '自動化',
  },
  'ko-KR': {
    books: '장부',
    accounts: '계좌 및 투자',
    reports: '보고서 및 세금',
    automations: '자동화',
  },
} as const;

export function FinanceBooks({
  onAnalyzeReport,
  onAskBook,
  onExplainTaxCase,
  ask,
  activity,
  documents,
  statementImports,
  planning,
  locale = 'en-CA',
  title = 'Finance',
  description = 'Books, documents, and financial decisions in one workspace.',
}: {
  onAnalyzeReport?: AnalyzeBookReport;
  onAskBook?: (bookId: string) => Promise<boolean>;
  onExplainTaxCase?: (caseId: string) => Promise<boolean>;
  ask?: ReactNode;
  activity?: ReactNode;
  documents?: ReactNode;
  statementImports?: ReactNode;
  planning?: ReactNode;
  locale?: FinanceLocale;
  title?: string;
  description?: string;
} = {}) {
  const auth = useAuth();
  const [activeView, setActiveView] = useState<WorkspaceView>('overview');
  const [visited, setVisited] = useState<readonly WorkspaceView[]>([
    'overview',
  ]);
  const [bookView, setBookView] = useState('ledger');
  const [documentView, setDocumentView] = useState('book');
  const [reportView, setReportView] = useState('mapping');
  const [assistantOpen, setAssistantOpen] = useState(true);
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState(false);
  const createDetails = useRef<HTMLDetailsElement>(null);
  const assistantRef = useRef<HTMLElement>(null);
  const selectedRef = useRef('');
  const labels = { ...financeCopy[locale].views, ...additionalLabels[locale] };
  const [books, setBooks] = useState<BookView[]>([]);
  const [selected, setSelected] = useState('');
  const [overview, setOverview] = useState<z.infer<typeof Overview>>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | undefined>(undefined);
  const pendingCreate = useRef<{ payload: string; key: string } | undefined>(
    undefined,
  );
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    pendingCreate.current = undefined;
    controller.current?.abort();
    setBooks([]);
    setSelected('');
    setOverview(undefined);
    selectedRef.current = '';
    setActiveView('overview');
    setVisited(['overview']);
    setError('');
    void load();
  }, [auth.sessionBinding]);
  useEffect(
    () => () => {
      generation.current++;
      controller.current?.abort();
    },
    [],
  );
  async function read(path: string, signal: AbortSignal) {
    const response = await fetch(path, {
      credentials: 'same-origin',
      cache: 'no-store',
      signal,
    });
    if (!response.ok)
      throw new Error(
        response.status === 503
          ? 'Books are not enabled for this environment yet.'
          : 'Unable to load books. Check your access and try again.',
      );
    try {
      return (await response.json()) as unknown;
    } catch {
      throw new Error('Book data is unavailable. Please try again.');
    }
  }
  async function load(bookId = '') {
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    const current = generation.current;
    setError('');
    setBusy(true);
    if (bookId && bookId !== selected) setOverview(undefined);
    try {
      if (bookId) {
        const result = Overview.parse(
          await read(`/api/v2/finance/books/${bookId}`, next.signal),
        );
        if (current === generation.current && !next.signal.aborted)
          setOverview(result);
      } else {
        const result = z
          .object({ books: z.array(Book) })
          .parse(await read('/api/v2/finance/books', next.signal));
        if (current !== generation.current || next.signal.aborted) return;
        setBooks(result.books);
        const nextBook =
          result.books.find((value) => value.id === selectedRef.current) ??
          result.books[0];
        selectedRef.current = nextBook?.id ?? '';
        setSelected(selectedRef.current);
        if (!nextBook || nextBook.id !== selected) setOverview(undefined);
        if (nextBook) {
          const detail = Overview.parse(
            await read(`/api/v2/finance/books/${nextBook.id}`, next.signal),
          );
          if (current === generation.current && !next.signal.aborted)
            setOverview(detail);
        }
      }
    } catch (e) {
      if (!next.signal.aborted && current === generation.current) {
        setOverview(undefined);
        setError(
          e instanceof z.ZodError
            ? 'The book data could not be loaded. Please try again.'
            : e instanceof Error
              ? e.message
              : 'Unable to load books.',
        );
      }
    } finally {
      if (!next.signal.aborted && current === generation.current)
        setBusy(false);
    }
  }
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!auth.csrfToken || busy) return;
    const data = new FormData(event.currentTarget);
    const current = generation.current;
    const payload = {
      name: String(data.get('name')),
      entityName: String(data.get('entityName')),
      entityKind: String(data.get('entityKind')),
      country: String(data.get('country')),
      functionalCurrency: String(data.get('currency')),
    };
    const encoded = JSON.stringify(payload);
    if (pendingCreate.current?.payload !== encoded)
      pendingCreate.current = { payload: encoded, key: crypto.randomUUID() };
    const key = pendingCreate.current.key;
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/v2/finance/books', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': auth.csrfToken,
          'idempotency-key': key,
        },
        body: encoded,
      });
      if (!response.ok)
        throw new Error(
          'Book creation could not be confirmed. Refresh the book list before trying again.',
        );
      if (current === generation.current) {
        pendingCreate.current = undefined;
        await load();
      }
    } catch (e) {
      if (current === generation.current)
        setError(e instanceof Error ? e.message : 'Unable to create book.');
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }
  const book = books.find((value) => value.id === selected);
  function navigate(view: WorkspaceView) {
    setActiveView(view);
    setVisited((current) =>
      current.includes(view) ? current : [...current, view],
    );
  }
  function moveTab(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? views.length - 1
          : event.key === 'ArrowRight'
            ? (index + 1) % views.length
            : event.key === 'ArrowLeft'
              ? (index + views.length - 1) % views.length
              : undefined;
    if (next === undefined) return;
    event.preventDefault();
    navigate(views[next]!);
    event.currentTarget.parentElement
      ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
      .item(next)
      ?.focus();
  }
  function openAssistant() {
    setAssistantOpen(true);
    requestAnimationFrame(() => {
      assistantRef.current?.scrollIntoView({
        block: 'nearest',
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
          ? 'instant'
          : 'smooth',
      });
      assistantRef.current
        ?.querySelector<HTMLTextAreaElement>('textarea')
        ?.focus({ preventScroll: true });
    });
  }
  const unavailable = (
    <div className="finance-empty">
      <span className="finance-empty__icon">
        <Icon name="wallet" size={25} />
      </span>
      <h2>
        {busy
          ? 'Loading your books'
          : error
            ? 'Books are unavailable'
            : 'Start with an accounting book'}
      </h2>
      <p role={error ? 'alert' : busy ? 'status' : undefined}>
        {busy
          ? 'Retrieving the books you can access.'
          : error ||
            'Keep records for each legal entity in its own book. Create a book or request access from its administrator.'}
      </p>
      {!busy && (
        <Button
          variant="secondary"
          onClick={() =>
            error
              ? void load()
              : createDetails.current?.setAttribute('open', '')
          }
        >
          {error ? 'Try again' : 'Create a book'}
        </Button>
      )}
    </div>
  );
  const trialBalance = (preview = false) => (
    <div className="finance-ledger">
      <div className="finance-panel-heading">
        <h2>
          {preview
            ? 'Trial balance'
            : `${book?.name} — trial balance (${book?.functionalCurrency})`}
        </h2>
        {preview && (
          <>
            <span className="finance-currency">{book?.functionalCurrency}</span>
            <Button variant="quiet" onClick={() => navigate('books')}>
              View books
              <Icon name="chevron-right" size={16} />
            </Button>
          </>
        )}
      </div>
      {overview?.trialBalance.length ? (
        <div
          className="finance-table-scroll"
          tabIndex={0}
          aria-label="Trial balance table"
        >
          <table>
            <thead>
              <tr>
                <th scope="col">Account</th>
                <th scope="col">Debit</th>
                <th scope="col">Credit</th>
                <th scope="col">Net debit</th>
              </tr>
            </thead>
            <tbody>
              {overview.trialBalance
                .slice(0, preview ? 5 : undefined)
                .map((row) => (
                  <tr key={row.id}>
                    <th scope="row">
                      <span className="finance-account-code">{row.code}</span>
                      {row.name}
                    </th>
                    <td>{row.debit}</td>
                    <td>{row.credit}</td>
                    <td>{row.balance}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="finance-empty-line">
          No ledger accounts recorded in this book.
        </p>
      )}
      <p className="finance-caption">
        Posted journal balances. Source detail is available in Books.
      </p>
    </div>
  );
  const journals = (preview = false) => (
    <section className="finance-journals" aria-label="Posted journals">
      <div className="finance-panel-heading">
        <h2>{preview ? 'Recent activity' : 'Posted journals'}</h2>
        {preview && (
          <Button
            variant="quiet"
            onClick={() => {
              setBookView('periods');
              navigate('books');
            }}
          >
            View journals
            <Icon name="chevron-right" size={16} />
          </Button>
        )}
      </div>
      {overview?.journals.length ? (
        <ul className="finance-record-list">
          {overview.journals
            .slice(0, preview ? 3 : undefined)
            .map((journal) => (
              <li key={journal.id}>
                <details>
                  <summary>
                    <span>{journal.description}</span>
                    <time>{journal.effectiveOn}</time>
                  </summary>
                  <dl className="finance-source-detail">
                    <dt>Source</dt>
                    <dd>{journal.sourceReference}</dd>
                    <dt>Journal</dt>
                    <dd>{journal.id}</dd>
                    {journal.reversalOf && (
                      <>
                        <dt>Reverses</dt>
                        <dd>{journal.reversalOf}</dd>
                      </>
                    )}
                  </dl>
                </details>
              </li>
            ))}
        </ul>
      ) : (
        <p className="finance-empty-line">No posted journals yet.</p>
      )}
    </section>
  );
  const bookContent = (view: WorkspaceView) => {
    if (view === 'planning')
      return (
        <div className="finance-surface finance-workspace-records">
          <div className="finance-scope-note">
            <Icon name="info" size={18} />
            <p>
              Workspace budgets use reviewed CAD records and are separate from
              the selected book.
            </p>
          </div>
          {book ? (
            <FinancePlanning bookId={book.id} bookName={book.name} />
          ) : null}
          {planning}
        </div>
      );
    if (view === 'activity')
      return (
        <div className="finance-surface finance-workspace-records">
          <div className="finance-scope-note">
            <Icon name="info" size={18} />
            <p>
              Workspace activity and manual records. Posted book journals are
              available in Books.
            </p>
          </div>
          {activity}
        </div>
      );
    if (view === 'automations')
      return (
        <div className="finance-surface">
          {book ? (
            <FinanceAutomations
              bookId={book.id}
              bookName={book.name}
              role={book.role}
            />
          ) : (
            <div className="finance-empty">
              <span className="finance-empty__icon">
                <Icon name="clock" size={26} />
              </span>
              <h2>Automation grants</h2>
              <p>
                Select an accessible accounting book to review its automation
                authority.
              </p>
            </div>
          )}
        </div>
      );
    if (view === 'reports' && reportView === 'fec')
      return book && overview ? (
        <FinanceFec
          bookId={book.id}
          bookName={book.name}
          role={book.role}
          accounts={overview.trialBalance}
          journals={overview.journals}
        />
      ) : (
        unavailable
      );
    if (view === 'reports' && reportView === 'tax')
      return (
        <FinanceTaxWorkspace
          {...(onExplainTaxCase
            ? {
                onExplainCase: async (caseId: string) => {
                  openAssistant();
                  return onExplainTaxCase(caseId);
                },
              }
            : {})}
        />
      );
    if (view === 'reports' && reportView === 'saved')
      return book ? (
        <div className="finance-surface">
          <FinanceGeneratedReports
            bookId={book.id}
            bookName={book.name}
            role={book.role}
          />
        </div>
      ) : (
        unavailable
      );
    if (view === 'documents' && documentView === 'workspace')
      return (
        <div className="finance-surface finance-workspace-records">
          <div className="finance-scope-note">
            <Icon name="info" size={18} />
            <p>
              Private workspace uploads are separate from documents assigned to
              an accounting book.
            </p>
          </div>
          {documents}
        </div>
      );
    if (view === 'documents' && documentView === 'imports')
      return (
        <div className="finance-surface finance-workspace-records">
          <div className="finance-scope-note">
            <Icon name="info" size={18} />
            <p>
              Import a statement into a workspace account. Use Book documents
              for accounting book imports.
            </p>
          </div>
          {statementImports}
        </div>
      );
    if (!book || !overview) return unavailable;
    if (view === 'overview')
      return (
        <>
          <section
            className="finance-at-a-glance"
            aria-labelledby="book-glance-heading"
          >
            <h2 id="book-glance-heading">Your book at a glance</h2>
            <p>Based on posted records in {book.name}.</p>
            <dl className="finance-statistics">
              <div>
                <dt>Ledger accounts</dt>
                <dd>{overview.trialBalance.length}</dd>
              </div>
              <div>
                <dt>Posted journals</dt>
                <dd>{overview.journals.length}</dd>
              </div>
              <div>
                <dt>Open periods</dt>
                <dd>
                  {
                    overview.periods.filter(
                      (period) => period.status === 'open',
                    ).length
                  }
                </dd>
              </div>
            </dl>
          </section>
          <div className="finance-surface finance-overview-ledger">
            {trialBalance(true)}
            {journals(true)}
          </div>
          <section
            className="finance-surface finance-next-actions"
            aria-label="Next actions"
          >
            <h2>Next actions</h2>
            <button
              type="button"
              onClick={() => {
                setDocumentView('book');
                navigate('documents');
              }}
            >
              <span>Review documents</span>
              <Icon name="chevron-right" size={18} />
            </button>
            <button
              type="button"
              onClick={() => {
                setBookView('commercial');
                navigate('books');
              }}
            >
              <span>Manage receivables &amp; payables</span>
              <Icon name="chevron-right" size={18} />
            </button>
            <button type="button" onClick={() => navigate('accounts')}>
              <span>Build an investment valuation</span>
              <Icon name="chevron-right" size={18} />
            </button>
          </section>
        </>
      );
    if (view === 'books' && bookView === 'migration')
      return (
        <FinanceLegacyMigrations
          bookId={book.id}
          bookName={book.name}
          role={book.role}
          accounts={overview.trialBalance}
        />
      );
    if (view === 'books')
      return (
        <div className="finance-surface">
          {bookView === 'ledger' ? (
            trialBalance()
          ) : bookView === 'commercial' ? (
            <FinanceCommercial
              key={`${auth.sessionBinding}:${book.id}`}
              bookId={book.id}
              role={book.role}
              accounts={overview.trialBalance}
              onSaved={() => void load(book.id)}
            />
          ) : (
            <>
              <section className="finance-periods">
                <div className="finance-panel-heading">
                  <h2>Fiscal periods</h2>
                  <span className="finance-currency">
                    {book.functionalCurrency}
                  </span>
                </div>
                {overview.periods.length ? (
                  <ul className="finance-period-list">
                    {overview.periods.map((period) => (
                      <li key={period.id}>
                        <Icon name="calendar" size={19} />
                        <span>
                          {period.startsOn}
                          <span className="finance-date-divider">—</span>
                          {period.endsOn}
                        </span>
                        <span
                          className={`finance-status ${period.status === 'closed' ? 'finance-status--pending' : ''}`}
                        >
                          {period.status}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="finance-empty-line">
                    No fiscal periods created.
                  </p>
                )}
              </section>
              {journals()}
            </>
          )}
        </div>
      );
    if (view === 'documents')
      return (
        <div className="finance-surface">
          <FinanceBookDocuments
            key={`documents:${book.id}:${auth.sessionBinding}`}
            bookId={book.id}
            currency={book.functionalCurrency}
            role={book.role}
            accounts={overview.trialBalance}
            onSaved={() => void load(book.id)}
            {...(onAnalyzeReport ? { onAnalyze: onAnalyzeReport } : {})}
          />
        </div>
      );
    if (view === 'accounts')
      return (
        <div className="finance-surface">
          <FinanceInvestments
            key={`investments:${book.id}:${auth.sessionBinding}`}
            bookId={book.id}
            role={book.role}
          />
        </div>
      );
    if (view === 'reports')
      return (
        <div className="finance-surface">
          <FinanceReportMappings
            key={`mapping:${book.id}:${auth.sessionBinding}`}
            bookId={book.id}
            role={book.role}
            {...(onAnalyzeReport ? { onAnalyze: onAnalyzeReport } : {})}
          />
        </div>
      );
    return null;
  };
  return (
    <div className="finance-books finance-workspace">
      <PageHeader
        title={title}
        description={description}
        action={
          ask ? (
            <Button
              variant="secondary"
              aria-label="Open Finance assistant"
              onClick={openAssistant}
            >
              <Icon name="chat" size={18} />
              Ask EMDO
            </Button>
          ) : undefined
        }
      />
      <div
        className="finance-book-context"
        hidden={activeView === 'reports' && reportView === 'tax'}
      >
        <label className="finance-book-picker">
          Accounting book
          <select
            value={selected}
            disabled={busy || !books.length}
            onChange={(event) => {
              selectedRef.current = event.target.value;
              setSelected(event.target.value);
              void load(event.target.value);
            }}
          >
            {!books.length && (
              <option value="">
                {busy ? 'Loading books…' : 'No books available'}
              </option>
            )}
            {books.map((value) => (
              <option key={value.id} value={value.id}>
                {value.name} · {value.entityName} · {value.functionalCurrency}
              </option>
            ))}
          </select>
        </label>
        {book && (
          <dl className="finance-book-metadata">
            <div>
              <dt>Entity</dt>
              <dd>{book.entityName}</dd>
            </div>
            <div>
              <dt>Currency</dt>
              <dd>{book.functionalCurrency}</dd>
            </div>
            <div>
              <dt>Access</dt>
              <dd className="finance-role">{book.role}</dd>
            </div>
          </dl>
        )}
        <div className="finance-context-actions">
          <Button variant="quiet" disabled={busy} onClick={() => void load()}>
            <Icon name="sync" size={17} />
            <span>Refresh books</span>
          </Button>
          <Button
            variant="quiet"
            onClick={() => {
              createDetails.current?.setAttribute('open', '');
              createDetails.current
                ?.querySelector<HTMLInputElement>('input')
                ?.focus();
            }}
          >
            <Icon name="plus" size={17} />
            <span>Create a book</span>
          </Button>
        </div>
      </div>
      <details
        className="finance-create-book"
        ref={createDetails}
        hidden={activeView === 'reports' && reportView === 'tax'}
      >
        <summary>Create a book</summary>
        <div className="finance-create-book__heading">
          <div>
            <h2>A separate book for each entity</h2>
            <p>Book access is private until an administrator grants it.</p>
          </div>
          <Button
            variant="quiet"
            onClick={() => createDetails.current?.removeAttribute('open')}
          >
            Close
          </Button>
        </div>
        <form onSubmit={(event) => void create(event)}>
          <label>
            Book name
            <input name="name" required maxLength={200} />
          </label>
          <label>
            Legal entity name
            <input name="entityName" required maxLength={200} />
          </label>
          <label>
            Entity type
            <select name="entityKind">
              <option value="individual">Individual</option>
              <option value="sole-proprietor">Sole proprietor</option>
              <option value="corporation">Corporation</option>
            </select>
          </label>
          <label>
            Country
            <select name="country">
              {[
                ['CA', 'Canada'],
                ['US', 'USA'],
                ['MX', 'Mexico'],
                ['DE', 'Germany'],
                ['KR', 'South Korea'],
                ['JP', 'Japan'],
                ['FR', 'France'],
              ].map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Functional currency
            <select name="currency">
              {FinanceCurrencySchema.options.map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <div className="finance-form-submit">
            <Button type="submit" disabled={busy || !auth.csrfToken}>
              Create private book
            </Button>
          </div>
        </form>
      </details>
      <div
        className="finance-workspace-tabs"
        role="tablist"
        aria-label={financeCopy[locale].viewsAriaLabel}
      >
        {views.map((view, index) => (
          <button
            type="button"
            role="tab"
            key={view}
            id={`finance-${view}-tab`}
            aria-selected={activeView === view}
            aria-controls={`finance-${view}-panel`}
            tabIndex={activeView === view ? 0 : -1}
            onClick={() => navigate(view)}
            onKeyDown={(event) => moveTab(event, index)}
          >
            {labels[view]}
          </button>
        ))}
      </div>
      {error && book && overview && (
        <p className="finance-error-banner" role="alert">
          <Icon name="info" size={18} />
          {error}
        </p>
      )}
      <div
        className={`finance-workspace-layout ${activeView === 'overview' && ask && assistantOpen ? (book && overview ? 'finance-workspace-layout--overview' : 'finance-workspace-layout--empty') : ''}`}
      >
        <div className="finance-workspace-main">
          {visited.map((view) => (
            <section
              key={view}
              className="finance-workspace-panel"
              role="tabpanel"
              id={`finance-${view}-panel`}
              aria-labelledby={`finance-${view}-tab`}
              hidden={activeView !== view}
              tabIndex={0}
            >
              {view === 'books' && (
                <SubNavigation
                  label="Book views"
                  value={bookView}
                  onChange={setBookView}
                  items={[
                    ['ledger', 'Trial balance'],
                    ['commercial', 'Receivables & payables'],
                    ['periods', 'Periods & journals'],
                    ['migration', 'Move existing finance records'],
                  ]}
                />
              )}
              {view === 'documents' && (
                <SubNavigation
                  label="Document views"
                  value={documentView}
                  onChange={setDocumentView}
                  items={[
                    ['book', 'Book documents'],
                    ['workspace', 'Workspace uploads'],
                    ['imports', 'Statement imports'],
                  ]}
                />
              )}
              {view === 'reports' && (
                <SubNavigation
                  label="Report views"
                  value={reportView}
                  onChange={setReportView}
                  items={[
                    ['mapping', 'Report standardization'],
                    ['saved', 'Saved reports'],
                    ['tax', 'Tax cases'],
                    ['fec', 'France FEC'],
                  ]}
                />
              )}
              {bookContent(view)}
            </section>
          ))}
        </div>
        {ask && (
          <aside
            ref={assistantRef}
            className={`finance-assistant-rail ${activeView === 'overview' ? '' : 'finance-assistant-rail--full'}`}
            aria-label="Finance assistant"
            hidden={!assistantOpen}
          >
            <div className="finance-assistant-card">
              <div className="finance-assistant-heading">
                <span className="finance-assistant-symbol">
                  <Icon name="chat" size={21} />
                </span>
                <div>
                  <h2>Ask EMDO</h2>
                  <p>Work through your finances with source-aware answers.</p>
                </div>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Close Finance assistant"
                  onClick={() => setAssistantOpen(false)}
                >
                  <Icon name="plus" size={17} className="icon--close" />
                </button>
              </div>
              {book && onAskBook && (
                <div className="finance-assistant-suggestions">
                  <button
                    type="button"
                    disabled={asking}
                    onClick={() => {
                      setAsking(true);
                      setAskError(false);
                      void onAskBook(book.id)
                        .then(
                          (ok) => setAskError(!ok),
                          () => setAskError(true),
                        )
                        .finally(() => setAsking(false));
                    }}
                  >
                    <span>
                      {asking ? 'Requesting review…' : 'Review this book'}
                    </span>
                    <Icon name="chevron-right" size={16} />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setDocumentView('book');
                      navigate('documents');
                    }}
                  >
                    <span>Explain a document</span>
                    <Icon name="chevron-right" size={16} />
                  </button>
                </div>
              )}
              {askError && (
                <p role="alert" className="inline-error">
                  EMDO could not start this review. Please try again.
                </p>
              )}
              {ask}
            </div>
            {activeView === 'overview' && (
              <div className="finance-readiness-note">
                <Icon name="lock" size={20} />
                <div>
                  <h3>Tax returns</h3>
                  <p>Country packages are not available yet.</p>
                  <button
                    type="button"
                    className="text-action"
                    onClick={() => {
                      setReportView('tax');
                      navigate('reports');
                    }}
                  >
                    View readiness
                    <Icon name="chevron-right" size={15} />
                  </button>
                </div>
              </div>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}

function SubNavigation({
  label,
  value,
  onChange,
  items,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  items: readonly (readonly [string, string])[];
}) {
  return (
    <nav className="finance-subnav" aria-label={label}>
      {items.map(([id, text]) => (
        <button
          key={id}
          type="button"
          aria-current={value === id ? 'page' : undefined}
          onClick={() => onChange(id)}
        >
          {text}
        </button>
      ))}
    </nav>
  );
}
