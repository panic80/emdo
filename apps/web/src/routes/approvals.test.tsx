import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type {
  ActionDecisionReceipt,
  ApprovalApiClient,
  ProposalListResponse,
  ProposalView,
} from '../features/approval/approval-model.js';
import { ApprovalClientError } from '../features/approval/approval-model.js';
import { ApprovalsScreen } from './approvals.js';

const PROPOSAL_ID = '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f67';
const PAYLOAD_HASH = 'a'.repeat(64);
const APPROVAL_HASH = 'b'.repeat(64);

const detail: ProposalView = {
  schemaVersion: 1,
  id: PROPOSAL_ID,
  version: 3,
  state: 'pending',
  kind: 'scheduler.calendar.create',
  title: 'Dentist appointment',
  summary: 'Create one event on Personal',
  createdAt: '2026-08-09T16:00:00.000Z',
  expiresAt: '2026-08-09T16:10:00.000Z',
  payloadHash: PAYLOAD_HASH,
  approvalHash: APPROVAL_HASH,
  beforePreview: { summary: 'No event' },
  afterPreview: { summary: 'One new calendar event' },
  fields: [
    { label: 'Calendar', value: 'Personal' },
    { label: 'Time', value: 'Tuesday, 2:30 PM–3:30 PM' },
  ],
};

const list: ProposalListResponse = {
  schemaVersion: 1,
  items: [
    {
      id: detail.id,
      version: detail.version,
      state: detail.state,
      kind: detail.kind,
      title: detail.title,
      summary: detail.summary,
      createdAt: detail.createdAt,
      expiresAt: detail.expiresAt,
    },
  ],
};

const approvedReceipt: ActionDecisionReceipt = {
  schemaVersion: 1,
  id: '018f1f5e-7b24-7d2b-a8e1-4b2c3d4e5f68',
  proposalId: PROPOSAL_ID,
  payloadHash: PAYLOAD_HASH,
  approvalHash: APPROVAL_HASH,
  decision: 'approved',
  channel: 'authenticated-visual',
  decidedAt: '2026-08-09T16:01:19.000Z',
  idempotencyKey: 'decision:request-0001',
};

function createApi(
  overrides: Partial<ApprovalApiClient> = {},
): ApprovalApiClient {
  return {
    list: vi.fn(async () => list),
    getDetail: vi.fn(async () => detail),
    decide: vi.fn(async () => approvedReceipt),
    ...overrides,
  };
}

describe('ApprovalsScreen', () => {
  it('loads the authenticated bounded list and exact detail instead of demo fixtures', async () => {
    const api = createApi();
    render(
      <ApprovalsScreen
        api={api}
        authenticated
        csrfToken="csrf-current"
        now={() => new Date('2026-08-09T16:01:18.000Z')}
      />,
    );

    expect(
      await screen.findByRole('heading', { name: 'Pending approvals' }),
    ).toBeVisible();
    expect(
      await screen.findByRole('button', { name: /Dentist appointment/u }),
    ).toBeVisible();
    expect(await screen.findByText('One new calendar event')).toBeVisible();
    expect(api.list).toHaveBeenCalledWith(
      { state: 'pending', limit: 25 },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(api.getDetail).toHaveBeenCalledWith(
      PROPOSAL_ID,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(
      screen.queryByText('225 King St W, Toronto'),
    ).not.toBeInTheDocument();
  });

  it('obtains and consumes authenticated visual proof only after the visual button is pressed', async () => {
    const api = createApi();
    const user = userEvent.setup();
    render(
      <ApprovalsScreen
        api={api}
        authenticated
        csrfToken="csrf-current"
        now={() => new Date('2026-08-09T16:01:18.000Z')}
      />,
    );

    await user.click(
      await screen.findByRole('button', { name: 'Approve action' }),
    );

    expect(api.decide).toHaveBeenCalledWith(
      {
        proposal: detail,
        decision: 'approve',
        csrfToken: 'csrf-current',
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(
      await screen.findByText(
        'Approved. EMDO is verifying the provider write.',
      ),
    ).toBeVisible();
    await waitFor(() =>
      expect(screen.queryByText('Dentist appointment')).not.toBeInTheDocument(),
    );
  });

  it('fails closed without a current online mutation proof', async () => {
    const api = createApi();
    render(
      <ApprovalsScreen
        api={api}
        authenticated
        now={() => new Date('2026-08-09T16:01:18.000Z')}
      />,
    );

    expect(
      await screen.findByRole('button', { name: 'Approval unavailable' }),
    ).toBeDisabled();
    expect(
      screen.getByText(
        'Reconnect and refresh to obtain a current authenticated visual proof.',
      ),
    ).toBeVisible();
    expect(api.decide).not.toHaveBeenCalled();
  });

  it('refuses a detail projection that changed after the bounded list was loaded', async () => {
    const api = createApi({
      getDetail: vi.fn(async () => ({ ...detail, version: 4 })),
    });
    render(
      <ApprovalsScreen
        api={api}
        authenticated
        csrfToken="csrf-current"
        now={() => new Date('2026-08-09T16:01:18.000Z')}
      />,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This proposal changed. Refresh and review the current details before deciding.',
    );
    expect(
      screen.queryByRole('button', { name: 'Approve action' }),
    ).not.toBeInTheDocument();
    expect(api.decide).not.toHaveBeenCalled();
  });

  it('drops a rejected cursor and restarts from the bounded first page', async () => {
    const restartedList: ProposalListResponse = {
      ...list,
      items: [{ ...list.items[0]!, title: 'Updated dentist appointment' }],
    };
    const api = createApi({
      list: vi
        .fn()
        .mockResolvedValueOnce({ ...list, nextCursor: 'tampered-cursor' })
        .mockRejectedValueOnce(
          new ApprovalClientError(
            'proposal-cursor-invalid',
            'This approvals page expired. Restarting from the first page.',
            400,
          ),
        )
        .mockResolvedValueOnce(restartedList),
    });
    const user = userEvent.setup();
    render(
      <ApprovalsScreen
        api={api}
        authenticated
        csrfToken="csrf-current"
        now={() => new Date('2026-08-09T16:01:18.000Z')}
      />,
    );

    await user.click(await screen.findByRole('button', { name: 'Load more' }));

    expect(
      await screen.findByRole('button', {
        name: /Updated dentist appointment/u,
      }),
    ).toBeVisible();
    expect(api.list).toHaveBeenNthCalledWith(
      2,
      { state: 'pending', cursor: 'tampered-cursor', limit: 25 },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(api.list).toHaveBeenNthCalledWith(
      3,
      { state: 'pending', limit: 25 },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
