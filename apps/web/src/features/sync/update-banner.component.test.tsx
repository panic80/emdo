import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { SafeUpdateCoordinator } from './update-coordinator.js';
import { UpdateBanner } from './update-banner.js';

describe('UpdateBanner', () => {
  it('explains that pending edits block a waiting update and does not activate it', async () => {
    const activateWaitingWorker = vi.fn(async () => undefined);
    const coordinator = new SafeUpdateCoordinator({ activateWaitingWorker });
    coordinator.setPendingChanges(2);
    coordinator.markUpdateWaiting();
    render(<UpdateBanner coordinator={coordinator} pendingChanges={2} />);

    expect(screen.getByRole('status')).toHaveTextContent(
      'An EMDO update is ready. Sync or discard 2 local changes first.',
    );
    expect(screen.getByRole('button', { name: 'Update EMDO' })).toBeDisabled();
    expect(activateWaitingWorker).not.toHaveBeenCalled();
  });

  it('applies a waiting update after local changes are clear', async () => {
    const activateWaitingWorker = vi.fn(async () => undefined);
    const coordinator = new SafeUpdateCoordinator({ activateWaitingWorker });
    coordinator.markUpdateWaiting();
    render(<UpdateBanner coordinator={coordinator} pendingChanges={0} />);

    await userEvent.click(screen.getByRole('button', { name: 'Update EMDO' }));
    expect(activateWaitingWorker).toHaveBeenCalledTimes(1);
  });
});
