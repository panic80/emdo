import { useEffect, useRef, useState, type FormEvent } from 'react';
import { z } from 'zod';
import {
  AuthorizePrivateTaxBookSourceSchema,
  GrantPrivateTaxCaseSchema,
  RevokePrivateTaxCaseGrantSchema,
  UuidSchema,
} from '@emdo/contracts/browser';
import { Button } from '../../components/button.js';
import { Icon } from '../../components/icon.js';
import {
  TaxBooksSchema,
  TaxGrantsSchema,
  TaxMembersSchema,
  TaxMutationSchema,
  TaxRequestError,
  readTaxJson,
  taxRoleDescriptions,
  type TaxBook,
  type TaxCaseDetail,
  type TaxGrant,
} from './finance-tax-model.js';
import type { TaxCaseOperation } from './finance-tax-workspace.js';

const GrantReceipt = z.object({
  caseId: UuidSchema,
  revision: z.number().int().positive(),
});
const RevokeSourceReceipt = z.object({
  caseId: UuidSchema,
  authorizationRevision: z.number().int().positive(),
});
const RevokeSourceInput = z.strictObject({
  expectedAuthorizationRevision: z.number().int().positive(),
});
type GrantInput = z.infer<typeof GrantPrivateTaxCaseSchema>;

export function FinanceTaxAccess({
  detail,
  onAccessUnavailable,
  disabled,
  operate,
}: {
  detail: TaxCaseDetail;
  onAccessUnavailable: (message: string) => void;
  disabled: boolean;
  operate: TaxCaseOperation;
}) {
  const grantEditor = useRef<HTMLDetailsElement>(null);
  const owner = detail.caseRole === 'owner';
  const sources = detail.questionnaire.sourceAuthorizationBindings;
  const [books, setBooks] = useState<TaxBook[]>();
  const [grants, setGrants] = useState<TaxGrant[]>();
  const [members, setMembers] =
    useState<z.infer<typeof TaxMembersSchema>['memberships']>();
  const [bookError, setBookError] = useState(''),
    [grantError, setGrantError] = useState(''),
    [memberError, setMemberError] = useState('');
  const [bookId, setBookId] = useState(''),
    [authorize, setAuthorize] = useState(false);
  const [revokeSource, setRevokeSource] = useState<(typeof sources)[number]>();
  const [revokeChecked, setRevokeChecked] = useState(false);
  const [grant, setGrant] = useState<GrantInput>(),
    [revokeGrant, setRevokeGrant] = useState<TaxGrant>();
  const [userId, setUserId] = useState(''),
    [role, setRole] = useState<GrantInput['role']>('viewer');
  const [loadingMembers, setLoadingMembers] = useState(false);
  const control = useRef<AbortController | undefined>(undefined);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    if (!owner) return;
    const controller = new AbortController();
    control.current = controller;
    setBooks(undefined);
    setGrants(undefined);
    setBookError('');
    setGrantError('');
    void readTaxJson('/api/v2/finance/books', controller.signal)
      .then((raw) => {
        const value = TaxBooksSchema.parse(raw);
        if (!controller.signal.aborted) setBooks(value.books);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted)
          setBookError(
            failure instanceof Error
              ? failure.message
              : 'Available books could not be loaded.',
          );
      });
    void readTaxJson(
      `/api/v2/finance/tax/cases/${detail.caseId}/grants`,
      controller.signal,
    )
      .then((raw) => {
        const value = TaxGrantsSchema.parse(raw);
        if (!controller.signal.aborted) setGrants(value);
      })
      .catch((failure: unknown) => {
        if (
          !controller.signal.aborted &&
          failure instanceof TaxRequestError &&
          [401, 403].includes(failure.status)
        ) {
          onAccessUnavailable(
            'Current case access could not be confirmed. Private inputs have been cleared; refresh the case to check access.',
          );
          return;
        }
        if (!controller.signal.aborted)
          setGrantError(
            failure instanceof Error
              ? failure.message
              : 'Case access could not be loaded.',
          );
      });
    return () => controller.abort();
  }, [detail.caseId, owner, generation]);
  async function loadMembers() {
    if (!control.current || control.current.signal.aborted || loadingMembers)
      return;
    const signal = control.current.signal;
    setLoadingMembers(true);
    setMemberError('');
    try {
      const result = TaxMembersSchema.parse(
        await readTaxJson('/api/v1/household/memberships', signal),
      );
      if (!signal.aborted)
        setMembers(
          result.memberships.filter((member) => member.status === 'active'),
        );
    } catch {
      if (!signal.aborted)
        setMemberError(
          'The member directory is unavailable with your current access. You can enter a known workspace member ID.',
        );
    } finally {
      if (!signal.aborted) setLoadingMembers(false);
    }
  }
  function prepareGrant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setGrantError('');
    try {
      const id = UuidSchema.parse(userId.trim());
      const existing = grants?.find((item) => item.userId === id);
      if (!grants || existing?.role === 'owner')
        throw new Error('The case owner’s access cannot be changed here.');
      setGrant(
        GrantPrivateTaxCaseSchema.parse({
          userId: id,
          role,
          expectedGrantRevision: existing?.revision ?? null,
        }),
      );
    } catch (failure) {
      setGrantError(
        failure instanceof z.ZodError
          ? 'Enter a valid workspace member ID.'
          : failure instanceof Error
            ? failure.message
            : 'Check this access change.',
      );
    }
  }
  const name = (id: string) =>
    members?.find((member) => member.userId === id)?.email ?? id;
  const bookName = (id: string) =>
    books?.find((book) => book.id === id)?.name ?? `Book ${id}`;
  const chosenBook = books?.find((book) => book.id === bookId);
  return (
    <div className="finance-tax-access">
      <section>
        <div className="finance-tax-heading">
          <div>
            <h3>Authorized book sources</h3>
            <p>
              Each source is an explicitly authorized, saved ledger snapshot for
              this private case.
            </p>
          </div>
          <span className="finance-tax-badge">{sources.length} attached</span>
        </div>
        <ul className="finance-tax-source-list">
          {sources.map((source) => (
            <li key={source.authorizationId}>
              <span className="finance-tax-source-icon">
                <Icon name="wallet" size={20} />
              </span>
              <div>
                <strong>{bookName(source.bookId)}</strong>
                <small>
                  Saved snapshot {source.snapshotRevision} · authorization
                  revision {source.authorizationRevision}
                </small>
                <details>
                  <summary>Source provenance</summary>
                  <dl className="finance-tax-facts">
                    <div>
                      <dt>Book reference</dt>
                      <dd>
                        <code>{source.bookId}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>Authorization</dt>
                      <dd>
                        <code>{source.authorizationId}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>Snapshot fingerprint</dt>
                      <dd>
                        <code>{source.snapshotHash}</code>
                      </dd>
                    </div>
                  </dl>
                </details>
              </div>
              {owner && (
                <Button
                  variant="quiet"
                  disabled={disabled || !grants}
                  onClick={() => {
                    setRevokeSource(source);
                    setRevokeChecked(false);
                  }}
                >
                  Review removal of {bookName(source.bookId)}
                </Button>
              )}
            </li>
          ))}
        </ul>
        {!sources.length && (
          <div className="finance-tax-empty finance-tax-empty--compact">
            <Icon name="lock" size={23} />
            <h4>No book sources authorized</h4>
            <p>
              {owner
                ? 'Choose a book below to review and authorize a snapshot. Selecting a book elsewhere never adds it to this case.'
                : 'Only the case owner can authorize a book source.'}
            </p>
          </div>
        )}
        {owner && (
          <div className="finance-tax-editor">
            <h4>Authorize a book snapshot</h4>
            {bookError && <p role="alert">{bookError}</p>}
            {!books && !bookError && (
              <p role="status">Loading books you can access…</p>
            )}
            <div className="finance-tax-form-grid">
              <label>
                Book to authorize
                <select
                  value={bookId}
                  disabled={disabled || !books || !grants}
                  onChange={(event) => {
                    setBookId(event.target.value);
                    setAuthorize(false);
                  }}
                >
                  <option value="">Choose a book explicitly</option>
                  {books
                    ?.filter(
                      (book) =>
                        !sources.some((source) => source.bookId === book.id),
                    )
                    .map((book) => (
                      <option value={book.id} key={book.id}>
                        {book.name} · {book.entityName} ·{' '}
                        {book.functionalCurrency}
                      </option>
                    ))}
                </select>
              </label>
            </div>
            {chosenBook && (
              <div className="finance-tax-review">
                <p>
                  <strong>{chosenBook.name}</strong> · {chosenBook.entityName} ·{' '}
                  {chosenBook.functionalCurrency}
                </p>
                <p>
                  This captures the book’s current posted ledger for this tax
                  case. People granted case access can read the authorized
                  source while its permissions remain valid. Future ledger
                  changes are not added automatically.
                </p>
                <label className="finance-tax-check">
                  <input
                    type="checkbox"
                    checked={authorize}
                    disabled={disabled}
                    onChange={(event) => setAuthorize(event.target.checked)}
                  />
                  <span>
                    I authorize this book snapshot for this private tax case.
                  </span>
                </label>
                <Button
                  disabled={disabled || !authorize || !grants}
                  onClick={() =>
                    void operate(
                      'book-sources',
                      AuthorizePrivateTaxBookSourceSchema.parse({
                        bookId: chosenBook.id,
                        expectedCaseRevision: detail.currentRevision,
                      }),
                      TaxMutationSchema,
                      'Book snapshot explicitly authorized for this tax case.',
                    ).catch(() => undefined)
                  }
                >
                  Authorize book snapshot
                </Button>
              </div>
            )}
          </div>
        )}
        {revokeSource && (
          <div
            className="finance-tax-confirm"
            role="group"
            aria-label="Confirm source removal"
          >
            <h4>Remove authorization for {bookName(revokeSource.bookId)}?</h4>
            <p>
              This revokes authorization revision{' '}
              {revokeSource.authorizationRevision}. The current questionnaire
              inputs become unavailable. The case owner must then reset
              questionnaire inputs before continuing; declaration source history
              is retained.
            </p>
            <label className="finance-tax-check">
              <input
                type="checkbox"
                checked={revokeChecked}
                disabled={disabled}
                onChange={(event) => setRevokeChecked(event.target.checked)}
              />
              <span>
                I understand this will make the current questionnaire inputs
                unavailable.
              </span>
            </label>
            <div className="finance-tax-actions">
              <Button
                variant="danger"
                disabled={disabled || !revokeChecked || !grants}
                onClick={() =>
                  void operate(
                    `book-sources/${revokeSource.authorizationId}/revoke`,
                    RevokeSourceInput.parse({
                      expectedAuthorizationRevision:
                        revokeSource.authorizationRevision,
                    }),
                    RevokeSourceReceipt,
                    'Source authorization removed. Review questionnaire recovery before continuing.',
                  ).catch(() => undefined)
                }
              >
                Remove source authorization
              </Button>
              <Button
                variant="quiet"
                disabled={disabled}
                onClick={() => {
                  setRevokeSource(undefined);
                  setRevokeChecked(false);
                }}
              >
                Keep source authorization
              </Button>
            </div>
          </div>
        )}
      </section>
      <section className="finance-tax-people">
        <div className="finance-tax-heading">
          <div>
            <h3>Case access</h3>
            <p>
              Access applies only to this private case. Accounting book and
              workspace roles do not grant it automatically.
            </p>
          </div>
          {owner && (
            <Button
              variant="quiet"
              disabled={disabled}
              onClick={() => {
                setGrant(undefined);
                setRevokeGrant(undefined);
                setGeneration((value) => value + 1);
              }}
            >
              Refresh case access
            </Button>
          )}
        </div>
        {!owner ? (
          <p>
            Your case role is <strong>{detail.caseRole}</strong>. Only the case
            owner can view and manage other people’s access.
          </p>
        ) : (
          <>
            {grantError && <p role="alert">{grantError}</p>}
            {!grants && !grantError && (
              <p role="status">Checking current case access…</p>
            )}
            {grants && (
              <ul className="finance-tax-source-list">
                {grants.map((item) => (
                  <li key={item.userId}>
                    <span className="finance-tax-source-icon">
                      <Icon name="user" size={19} />
                    </span>
                    <div>
                      <strong>
                        {item.role === 'owner'
                          ? 'Case owner'
                          : name(item.userId)}
                      </strong>
                      {item.role === 'owner' && (
                        <small>{name(item.userId)}</small>
                      )}
                      <small>
                        {item.role} · {item.status} · grant revision{' '}
                        {item.revision}
                      </small>
                      <p>{taxRoleDescriptions[item.role]}</p>
                    </div>
                    {item.role !== 'owner' && (
                      <div className="finance-tax-actions">
                        <Button
                          variant="quiet"
                          disabled={disabled}
                          onClick={() => {
                            setUserId(item.userId);
                            setRole(item.role as GrantInput['role']);
                            setGrant(undefined);
                            if (grantEditor.current) {
                              grantEditor.current.open = true;
                              grantEditor.current
                                .querySelector('input')
                                ?.focus();
                            }
                          }}
                        >
                          {item.status === 'revoked'
                            ? 'Review renewed access'
                            : 'Change role'}
                        </Button>
                        {item.status === 'active' && (
                          <Button
                            variant="quiet"
                            disabled={disabled}
                            onClick={() => setRevokeGrant(item)}
                          >
                            Review access removal
                          </Button>
                        )}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <details className="finance-tax-editor" ref={grantEditor}>
              <summary>Grant or change case access</summary>
              <form onSubmit={prepareGrant}>
                <p>
                  Choose a current workspace member and review the exact role
                  before saving.
                </p>
                <Button
                  type="button"
                  variant="quiet"
                  disabled={disabled || loadingMembers}
                  onClick={() => void loadMembers()}
                >
                  {loadingMembers
                    ? 'Loading members…'
                    : 'Load workspace member directory'}
                </Button>
                {memberError && <p role="status">{memberError}</p>}
                <fieldset disabled={disabled || !grants}>
                  <legend className="sr-only">Case access recipient</legend>
                  <div className="finance-tax-form-grid">
                    <label>
                      Workspace member ID
                      <input
                        required
                        value={userId}
                        onChange={(event) => {
                          setUserId(event.target.value);
                          setGrant(undefined);
                        }}
                        maxLength={36}
                        list={members ? 'tax-case-members' : undefined}
                        autoComplete="off"
                      />
                    </label>
                    {members && (
                      <datalist id="tax-case-members">
                        {members.map((member) => (
                          <option key={member.userId} value={member.userId}>
                            {member.email}
                          </option>
                        ))}
                      </datalist>
                    )}
                    <label>
                      Case role
                      <select
                        value={role}
                        onChange={(event) => {
                          setRole(event.target.value as GrantInput['role']);
                          setGrant(undefined);
                        }}
                      >
                        <option value="viewer">Viewer</option>
                        <option value="preparer">Preparer</option>
                        <option value="reviewer">Reviewer</option>
                      </select>
                      <small>{taxRoleDescriptions[role]}</small>
                    </label>
                  </div>
                </fieldset>
                <Button variant="secondary" disabled={disabled || !grants}>
                  Review case access
                </Button>
              </form>
            </details>
            {grant && (
              <div
                className="finance-tax-review"
                role="group"
                aria-label="Confirm case access"
              >
                <h4>Grant {grant.role} access?</h4>
                <p className="finance-tax-exact">{name(grant.userId)}</p>
                <p>
                  {taxRoleDescriptions[grant.role]} This includes access to the
                  case’s authorized sources while permissions remain valid.
                </p>
                <div className="finance-tax-actions">
                  <Button
                    disabled={disabled || !grants}
                    onClick={() =>
                      void operate(
                        'grants',
                        grant,
                        GrantReceipt,
                        'Case access updated.',
                      ).catch(() => undefined)
                    }
                  >
                    Save case access
                  </Button>
                  <Button
                    variant="quiet"
                    disabled={disabled}
                    onClick={() => setGrant(undefined)}
                  >
                    Cancel access change
                  </Button>
                </div>
              </div>
            )}
            {revokeGrant && (
              <div
                className="finance-tax-confirm"
                role="group"
                aria-label="Confirm access removal"
              >
                <h4>Remove {revokeGrant.role} access?</h4>
                <p className="finance-tax-exact">{name(revokeGrant.userId)}</p>
                <p>
                  This revokes grant revision {revokeGrant.revision}. This
                  person will no longer be able to read or change this case
                  through that grant.
                </p>
                <div className="finance-tax-actions">
                  <Button
                    variant="danger"
                    disabled={disabled || !grants}
                    onClick={() =>
                      void operate(
                        'grants/revoke',
                        RevokePrivateTaxCaseGrantSchema.parse({
                          userId: revokeGrant.userId,
                          expectedGrantRevision: revokeGrant.revision,
                        }),
                        GrantReceipt,
                        'Case access removed.',
                      ).catch(() => undefined)
                    }
                  >
                    Remove case access
                  </Button>
                  <Button
                    variant="quiet"
                    disabled={disabled}
                    onClick={() => setRevokeGrant(undefined)}
                  >
                    Keep case access
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
