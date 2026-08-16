import { useEffect, useMemo, useState } from 'react';

import { Button } from '../../components/button.js';
import { Icon } from '../../components/icon.js';
import {
  LogoutFlowController,
  type LogoutBoundaryAdapter,
  type LogoutFlowSnapshot,
} from './update-coordinator.js';

const unavailableBoundary: LogoutBoundaryAdapter = {
  inspect: async () => {
    throw new Error('Offline database lifecycle is not initialized');
  },
  syncAndPurge: async () => ({ status: 'logout-blocked' }),
  discardAndPurge: async () => ({ status: 'logout-blocked' }),
};

export function LogoutPanel({
  boundary,
  onComplete,
}: {
  readonly boundary?: LogoutBoundaryAdapter;
  readonly onComplete?: () => void;
}) {
  const controller = useMemo(
    () => new LogoutFlowController(boundary ?? unavailableBoundary),
    [boundary],
  );
  const [snapshot, setSnapshot] = useState<LogoutFlowSnapshot>({
    state: 'idle',
  });
  const [confirmation, setConfirmation] = useState('');

  useEffect(() => {
    if (snapshot.state === 'complete') onComplete?.();
  }, [onComplete, snapshot.state]);

  const refresh = () => setSnapshot(controller.snapshot());
  return (
    <section className="logout-panel" aria-labelledby="logout-heading">
      <h2 id="logout-heading">Log out on this device</h2>
      <p>
        Logout purges local SQLite/OPFS, wrapped keys, tokens, and private
        caches.
      </p>
      {snapshot.state === 'idle' ? (
        <Button
          variant="secondary"
          onClick={() => void controller.begin().then(refresh)}
        >
          Review logout
        </Button>
      ) : null}
      {snapshot.state === 'inspecting' ? (
        <p role="status">Checking offline changes…</p>
      ) : null}
      {snapshot.state === 'decision-required' ? (
        <div className="logout-decision">
          <p>
            <strong>
              {snapshot.pendingOperations} offline changes are waiting.
            </strong>{' '}
            Sync now or explicitly discard them.
          </p>
          <Button onClick={() => void controller.syncNow().then(refresh)}>
            Sync now and log out
          </Button>
          <label htmlFor="discard-confirmation">
            Type DISCARD OFFLINE CHANGES to discard
          </label>
          <input
            id="discard-confirmation"
            onChange={(event) => setConfirmation(event.target.value)}
            value={confirmation}
          />
          <Button
            variant="danger"
            onClick={() => void controller.discard(confirmation).then(refresh)}
          >
            Discard and log out
          </Button>
        </div>
      ) : null}
      {snapshot.state === 'syncing' || snapshot.state === 'discarding' ? (
        <p role="status">Securing local data…</p>
      ) : null}
      {snapshot.state === 'complete' ? (
        <p className="inline-notice" role="status">
          <Icon name="check" size={18} /> Server session revoked and local data
          purged.
        </p>
      ) : null}
      {snapshot.state === 'sync-failed' ? (
        <p className="inline-error" role="alert">
          Sync failed. Local data remains on this device; logout was not
          completed.
        </p>
      ) : null}
      {snapshot.state === 'logout-blocked' ? (
        <p className="inline-error" role="alert">
          Logout is blocked because EMDO could not verify a complete local
          purge.
        </p>
      ) : null}
      {snapshot.state === 'incomplete' ? (
        <p className="inline-error" role="alert">
          The server session was revoked, but local cleanup is incomplete.
          Editing is locked; retry cleanup from this screen.
        </p>
      ) : null}
    </section>
  );
}
