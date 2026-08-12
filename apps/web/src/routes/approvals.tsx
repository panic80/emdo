import { useEffect, useState } from 'react';

import { Button } from '../components/button.js';
import {
  ApprovalClientError,
  approvalApiClient,
  type ApprovalApiClient,
  type ProposalListItem,
  type ProposalView,
} from '../features/approval/approval-model.js';
import { ProposalDetail } from '../features/approval/proposal-detail.js';
import { useAuth } from '../features/auth/auth-context.js';

const safeErrorMessage = (error: unknown): string =>
  error instanceof ApprovalClientError
    ? error.message
    : 'EMDO could not load approvals. Refresh and try again.';

export function ApprovalsScreen({
  api,
  authenticated,
  csrfToken,
  now = () => new Date(),
}: {
  readonly api: ApprovalApiClient;
  readonly authenticated: boolean;
  readonly csrfToken?: string;
  readonly now?: () => Date;
}) {
  const [items, setItems] = useState<readonly ProposalListItem[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [proposal, setProposal] = useState<ProposalView>();
  const [nextCursor, setNextCursor] = useState<string>();
  const [loadingList, setLoadingList] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [error, setError] = useState<string>();
  const [receipt, setReceipt] = useState<string>();
  const [clock, setClock] = useState(() => now());
  const [refreshVersion, setRefreshVersion] = useState(0);

  useEffect(() => {
    const interval = window.setInterval(() => setClock(now()), 1_000);
    return () => window.clearInterval(interval);
  }, [now]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoadingList(true);
    setError(undefined);
    void api
      .list({ state: 'pending', limit: 25 }, { signal: controller.signal })
      .then((result) => {
        if (!active) return;
        setItems(result.items);
        setNextCursor(result.nextCursor);
        setSelectedId((current) =>
          current && result.items.some((item) => item.id === current)
            ? current
            : result.items[0]?.id,
        );
        if (result.items.length === 0) setProposal(undefined);
      })
      .catch((caught: unknown) => {
        if (!active || controller.signal.aborted) return;
        setItems([]);
        setSelectedId(undefined);
        setProposal(undefined);
        setError(safeErrorMessage(caught));
      })
      .finally(() => {
        if (active) setLoadingList(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [api, refreshVersion]);

  useEffect(() => {
    if (!selectedId) {
      setProposal(undefined);
      setLoadingDetail(false);
      return;
    }
    const selectedSummary = items.find((item) => item.id === selectedId);
    const controller = new AbortController();
    let active = true;
    setProposal(undefined);
    setLoadingDetail(true);
    setError(undefined);
    void api
      .getDetail(selectedId, { signal: controller.signal })
      .then((detail) => {
        if (!active) return;
        if (!selectedSummary || detail.version !== selectedSummary.version) {
          throw new ApprovalClientError(
            'proposal-not-current',
            'This proposal changed. Refresh and review the current details before deciding.',
          );
        }
        setProposal(detail);
      })
      .catch((caught: unknown) => {
        if (!active || controller.signal.aborted) return;
        setProposal(undefined);
        setError(safeErrorMessage(caught));
      })
      .finally(() => {
        if (active) setLoadingDetail(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [api, items, selectedId]);

  const loadMore = async () => {
    if (!nextCursor) return;
    const controller = new AbortController();
    setLoadingList(true);
    try {
      const result = await api.list(
        { state: 'pending', cursor: nextCursor, limit: 25 },
        { signal: controller.signal },
      );
      setItems((current) => {
        const ids = new Set(current.map((item) => item.id));
        return [
          ...current,
          ...result.items.filter((item) => !ids.has(item.id)),
        ];
      });
      setNextCursor(result.nextCursor);
    } catch (caught) {
      if (
        caught instanceof ApprovalClientError &&
        caught.code === 'proposal-cursor-invalid'
      ) {
        setNextCursor(undefined);
        setProposal(undefined);
        try {
          const restarted = await api.list(
            { state: 'pending', limit: 25 },
            { signal: controller.signal },
          );
          setItems(restarted.items);
          setNextCursor(restarted.nextCursor);
          setSelectedId(restarted.items[0]?.id);
          setError(undefined);
        } catch (restartError) {
          setError(safeErrorMessage(restartError));
        }
      } else {
        setError(safeErrorMessage(caught));
      }
    } finally {
      setLoadingList(false);
    }
  };

  const decide = async (decision: 'approve' | 'reject') => {
    if (!proposal || !authenticated || !csrfToken) {
      setError(
        'Reconnect and refresh to obtain a current authenticated visual proof.',
      );
      return;
    }
    const controller = new AbortController();
    try {
      const result = await api.decide(
        { proposal, decision, csrfToken },
        { signal: controller.signal },
      );
      setReceipt(
        result.decision === 'approved'
          ? 'Approved. EMDO is verifying the provider write.'
          : 'Proposal rejected. No provider write will occur.',
      );
      setError(undefined);
      const remaining = items.filter((item) => item.id !== proposal.id);
      setItems(remaining);
      setProposal(undefined);
      setSelectedId(remaining[0]?.id);
    } catch (caught) {
      setError(safeErrorMessage(caught));
    }
  };

  return (
    <main className="approval-page">
      <section
        className="approval-queue"
        aria-labelledby="approval-queue-heading"
      >
        <div className="approval-queue__heading">
          <div>
            <h1 id="approval-queue-heading">Pending approvals</h1>
            <p>
              Choose a proposal, review its current projection, then decide.
            </p>
          </div>
          <Button
            onClick={() => setRefreshVersion((version) => version + 1)}
            type="button"
            variant="secondary"
          >
            Refresh
          </Button>
        </div>
        {loadingList && items.length === 0 ? (
          <p role="status">Loading approvals…</p>
        ) : null}
        {!loadingList && items.length === 0 && !error ? (
          <p className="approval-queue__empty">No pending approvals.</p>
        ) : null}
        {items.length > 0 ? (
          <ul className="approval-queue__list">
            {items.map((item) => (
              <li key={item.id}>
                <button
                  aria-current={item.id === selectedId ? 'true' : undefined}
                  onClick={() => setSelectedId(item.id)}
                  type="button"
                >
                  <strong>{item.title}</strong>
                  <span>{item.summary}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {nextCursor ? (
          <Button
            busy={loadingList}
            onClick={() => void loadMore()}
            type="button"
            variant="secondary"
          >
            Load more
          </Button>
        ) : null}
      </section>

      {loadingDetail ? <p role="status">Loading proposal details…</p> : null}
      {proposal ? (
        <ProposalDetail
          authenticated={authenticated}
          error={error}
          now={clock}
          onDecision={decide}
          proposal={proposal}
          visualSession={Boolean(csrfToken)}
        />
      ) : null}
      {error && !proposal ? (
        <p className="approval-actions__error" role="alert">
          {error}
        </p>
      ) : null}
      {receipt ? (
        <p className="approval-receipt" role="status">
          {receipt}
        </p>
      ) : null}
    </main>
  );
}

export function ApprovalsRoute() {
  const auth = useAuth();
  return (
    <ApprovalsScreen
      api={approvalApiClient}
      authenticated={auth.state === 'authenticated'}
      csrfToken={auth.csrfToken}
    />
  );
}
