import { useEffect, useState } from 'react';

import { Button } from '../../components/button.js';
import { Icon } from '../../components/icon.js';
import { SafeUpdateCoordinator } from './update-coordinator.js';

export function UpdateBanner({
  pendingChanges,
  coordinator,
}: {
  readonly pendingChanges: number;
  readonly coordinator?: SafeUpdateCoordinator;
}) {
  const [snapshot, setSnapshot] = useState(() => {
    coordinator?.setPendingChanges(pendingChanges);
    return coordinator?.snapshot();
  });

  useEffect(() => {
    coordinator?.setPendingChanges(pendingChanges);
    setSnapshot(coordinator?.snapshot());
  }, [coordinator, pendingChanges]);

  useEffect(() => {
    if (!coordinator) return;
    const updateSnapshot = () => setSnapshot(coordinator.snapshot());
    window.addEventListener('emdo:update-waiting', updateSnapshot);
    return () =>
      window.removeEventListener('emdo:update-waiting', updateSnapshot);
  }, [coordinator]);

  if (!coordinator || !snapshot || snapshot.state === 'idle') return null;

  const blocked = snapshot.state === 'blocked-pending-changes';
  const apply = async () => {
    try {
      await coordinator.apply();
    } finally {
      setSnapshot(coordinator.snapshot());
    }
  };

  return (
    <div className="update-banner" role="status">
      <Icon name="sync" />
      <p>
        {blocked
          ? `An EMDO update is ready. Sync or discard ${snapshot.pendingChanges} local changes first.`
          : 'An EMDO update is ready.'}
      </p>
      <Button
        disabled={blocked || snapshot.state === 'activating'}
        onClick={() => void apply()}
      >
        Update EMDO
      </Button>
    </div>
  );
}
