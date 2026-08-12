import { useState } from 'react';

import { Button } from '../../components/button.js';
import { Icon } from '../../components/icon.js';
import {
  getApprovalAvailability,
  type ApprovalSource,
  type ProposalView,
} from './approval-model.js';

function formatRemaining(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

export function ProposalDetail({
  proposal,
  now,
  onDecision,
  authenticated = true,
  visualSession = true,
  error,
}: {
  readonly proposal: ProposalView;
  readonly now: Date;
  readonly onDecision: (
    decision: 'approve' | 'reject',
    source: ApprovalSource,
  ) => Promise<void> | void;
  readonly authenticated?: boolean;
  readonly visualSession?: boolean;
  readonly error?: string;
}) {
  const [busy, setBusy] = useState<'approve' | 'reject'>();
  const availability = getApprovalAvailability(proposal, {
    now,
    authenticated,
    visualSession,
  });
  const remaining = availability.allowed ? availability.remainingSeconds : 0;
  const expired =
    !availability.allowed &&
    (availability.reason === 'expired' ||
      availability.reason === 'invalid-expiry');
  const unavailableMessage =
    !availability.allowed &&
    availability.reason === 'visual-confirmation-required'
      ? 'Reconnect and refresh to obtain a current authenticated visual proof.'
      : !availability.allowed &&
          availability.reason === 'authentication-required'
        ? 'Sign in again before reviewing approvals.'
        : undefined;

  const decide = async (decision: 'approve' | 'reject') => {
    setBusy(decision);
    try {
      await onDecision(decision, 'visual-control');
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <article className="proposal-detail" aria-labelledby="proposal-title">
      <header className="proposal-detail__intro">
        <h1 id="proposal-title">Review approval</h1>
        <p>Review every detail before EMDO makes this change.</p>
        <div
          className={`expiry-clock ${availability.allowed ? '' : 'expiry-clock--expired'}`.trim()}
        >
          <Icon name="clock" />
          <span>
            {availability.allowed
              ? `Expires in ${formatRemaining(remaining)}`
              : expired
                ? 'Expired'
                : 'Approval unavailable'}
          </span>
        </div>
      </header>

      <section
        className="proposal-detail__event"
        aria-labelledby="proposal-action-heading"
      >
        <h2 id="proposal-action-heading">Proposed action</h2>
        <div className="proposal-detail__event-title">
          <span className="proposal-calendar-icon" aria-hidden="true">
            <Icon name="approval" size={26} />
          </span>
          <h3>{proposal.title}</h3>
          <Icon
            name="chevron-down"
            className="proposal-detail__collapse"
            size={24}
          />
        </div>
        <dl className="proposal-fields">
          {proposal.fields.map((field) => (
            <div key={field.label}>
              <dt>{field.label}</dt>
              <dd>{field.value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section
        className="proposal-change"
        aria-labelledby="proposal-change-heading"
      >
        <h2 id="proposal-change-heading">What will change</h2>
        <div className="field-comparison">
          <div>
            <span>Before</span>
            <strong>{proposal.beforePreview.summary}</strong>
            <Icon name="approval" size={38} />
          </div>
          <Icon
            className="field-comparison__arrow"
            name="chevron-right"
            size={28}
          />
          <div>
            <span className="field-comparison__after-label">After</span>
            <strong>{proposal.afterPreview.summary}</strong>
            <span className="field-comparison__after-icon">
              <Icon name="approval" size={38} />
              <Icon name="plus" size={18} />
            </span>
          </div>
        </div>
        <p className="proposal-disclosure">
          <Icon name="info" size={22} />
          <span>Only the fields shown here are covered by this approval.</span>
        </p>
      </section>

      <div className="approval-actions">
        <Button
          busy={busy === 'approve'}
          className="approval-actions__approve"
          disabled={!availability.allowed}
          onClick={() => void decide('approve')}
          type="button"
          aria-label={
            availability.allowed
              ? 'Approve action'
              : expired
                ? 'Approval expired'
                : 'Approval unavailable'
          }
        >
          <Icon name="lock" />
          <span>
            {availability.allowed
              ? 'Approve action'
              : expired
                ? 'Approval expired'
                : 'Approval unavailable'}
          </span>
        </Button>
        <Button
          busy={busy === 'reject'}
          disabled={!availability.allowed}
          onClick={() => void decide('reject')}
          type="button"
          variant="secondary"
          aria-label={
            availability.allowed ? 'Reject proposal' : 'Rejection unavailable'
          }
        >
          Reject
        </Button>
        {error || unavailableMessage ? (
          <p className="approval-actions__error" role="alert">
            {error ?? unavailableMessage}
          </p>
        ) : null}
        <p className="approval-actions__warning">
          <Icon name="shield-alert" size={28} />
          <span>
            Voice, typed replies, email, and notifications cannot approve this
            action.
          </span>
        </p>
      </div>
    </article>
  );
}
