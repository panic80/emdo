import { Button } from '../../components/button.js';
import { Icon } from '../../components/icon.js';
import { useDomainData } from './domain-data.js';

export function DomainSyncStatus() {
  const domain = useDomainData();
  const pending = domain.pendingCount;

  if (domain.state === 'initializing') {
    return (
      <p className="domain-sync-status" role="status">
        Opening encrypted offline data…
      </p>
    );
  }
  if (domain.state === 'unavailable' || domain.state === 'locked') {
    return (
      <p className="domain-sync-status domain-sync-status--error" role="alert">
        <Icon name="lock" size={17} />{' '}
        {domain.error ?? 'Offline editing is locked.'}
      </p>
    );
  }

  return (
    <section className="domain-sync-status">
      <div role="status">
        <Icon
          name={domain.state === 'offline-ready' ? 'info' : 'sync'}
          size={17}
        />
        <span>
          {domain.state === 'offline-ready'
            ? `${pending} local ${pending === 1 ? 'change' : 'changes'} queued · Connect to sync`
            : pending > 0
              ? `${pending} local ${pending === 1 ? 'change' : 'changes'} waiting to sync`
              : 'Encrypted offline data is up to date'}
        </span>
        {domain.state === 'ready' && pending > 0 ? (
          <Button
            variant="quiet"
            onClick={() => void domain.syncNow().catch(() => undefined)}
          >
            Sync now
          </Button>
        ) : null}
      </div>
      {domain.conflicts.length > 0 ? (
        <div aria-label="Offline changes requiring review">
          <strong>
            {domain.conflicts.length}{' '}
            {domain.conflicts.length === 1
              ? 'change needs review'
              : 'changes need review'}
          </strong>
          <ul>
            {domain.conflicts.map((conflict) => (
              <li key={conflict.operationId}>
                <code>{conflict.code}</code>
                {conflict.currentRevision !== undefined ? (
                  <span>Canonical revision {conflict.currentRevision}</span>
                ) : null}
                {conflict.conflicts.length > 0 ? (
                  <span>
                    {conflict.conflicts
                      .map(
                        ({ field, material }) =>
                          `${field} (${material ? 'material' : 'non-material'})`,
                      )
                      .join(', ')}
                  </span>
                ) : null}
                <Button
                  variant="quiet"
                  onClick={() =>
                    void domain
                      .dismissConflict(conflict.operationId)
                      .catch(() => undefined)
                  }
                  aria-label={`Dismiss ${conflict.code} review notice`}
                >
                  Dismiss
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
