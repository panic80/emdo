import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { createImmutableProposalView } from './approval-model.js';
import { ProposalDetail } from './proposal-detail.js';

const proposal = createImmutableProposalView({
  schemaVersion: 1 as const,
  id: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f67',
  version: 3,
  state: 'pending' as const,
  kind: 'scheduler.calendar.create',
  title: 'Dentist appointment',
  summary: 'Create one event on Personal',
  createdAt: '2026-08-09T16:00:00.000Z',
  expiresAt: '2026-08-09T16:10:00.000Z',
  payloadHash: 'a'.repeat(64),
  approvalHash: 'b'.repeat(64),
  beforePreview: { summary: 'No event' },
  afterPreview: { summary: '1 new Google Calendar event' },
  fields: [
    { label: 'Calendar', value: 'Personal' },
    { label: 'Date', value: 'Tuesday, August 11' },
    { label: 'Time', value: '2:30 PM–3:30 PM' },
    { label: 'Travel', value: 'Leave by 1:55 PM' },
    { label: 'Location', value: '225 King St W, Toronto' },
  ],
});

describe('ProposalDetail', () => {
  it('renders the exact immutable before/after preview and non-visual warning', () => {
    render(
      <ProposalDetail
        now={new Date('2026-08-09T16:01:18.000Z')}
        proposal={proposal}
        onDecision={vi.fn()}
      />,
    );

    expect(
      screen.getByRole('heading', { name: 'Review approval' }),
    ).toBeVisible();
    expect(screen.getByText('Expires in 08:42')).toBeVisible();
    expect(screen.getByText('No event')).toBeVisible();
    expect(screen.getByText('1 new Google Calendar event')).toBeVisible();
    expect(
      screen.getByText(
        'Voice, typed replies, email, and notifications cannot approve this action.',
      ),
    ).toBeVisible();
    expect(
      screen.queryByRole('textbox', { name: /confirm/i }),
    ).not.toBeInTheDocument();
  });

  it('emits approval only from the dedicated visual control and keeps rejection explicit', async () => {
    const onDecision = vi.fn(async () => undefined);
    render(
      <ProposalDetail
        now={new Date('2026-08-09T16:01:18.000Z')}
        proposal={proposal}
        onDecision={onDecision}
      />,
    );

    await userEvent.click(
      screen.getByRole('button', { name: 'Approve action' }),
    );
    expect(onDecision).toHaveBeenCalledWith('approve', 'visual-control');

    await userEvent.click(
      screen.getByRole('button', { name: 'Reject proposal' }),
    );
    expect(onDecision).toHaveBeenCalledWith('reject', 'visual-control');
  });

  it('fails closed for every visual decision after expiry', () => {
    render(
      <ProposalDetail
        now={new Date('2026-08-09T16:10:00.000Z')}
        proposal={proposal}
        onDecision={vi.fn()}
      />,
    );

    expect(
      screen.getByRole('button', { name: 'Approval expired' }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Rejection unavailable' }),
    ).toBeDisabled();
  });
});
