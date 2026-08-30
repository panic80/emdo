import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { AskComposer } from './ask-composer.js';

describe('AskComposer', () => {
  it('validates an empty request without dispatching', async () => {
    const onSubmit = vi.fn();
    render(<AskComposer onSubmit={onSubmit} />);

    await userEvent.click(screen.getByRole('button', { name: 'Ask EMDO' }));

    expect(
      await screen.findByText('Tell EMDO what you need help with.'),
    ).toBeVisible();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits a trimmed request and exposes an accessible push-to-talk control', async () => {
    const onSubmit = vi.fn(async () => undefined);
    render(<AskComposer onSubmit={onSubmit} />);

    await userEvent.type(
      screen.getByRole('textbox', { name: 'Ask EMDO' }),
      '  Plan dinner  ',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Ask EMDO' }));

    expect(onSubmit).toHaveBeenCalledWith('Plan dinner');
    expect(
      screen.getByRole('button', { name: 'Start push-to-talk' }),
    ).toHaveAccessibleName();
  });

  it('retains the request when the shared conversation rejects it', async () => {
    const onSubmit = vi.fn(async () => false);
    const user = userEvent.setup();
    render(<AskComposer onSubmit={onSubmit} />);

    const message = screen.getByRole('textbox', { name: 'Ask EMDO' });
    await user.type(message, 'Show my reviewed total');
    await user.click(screen.getByRole('button', { name: 'Ask EMDO' }));

    expect(onSubmit).toHaveBeenCalledWith('Show my reviewed total');
    expect((message as HTMLTextAreaElement).value).toBe(
      'Show my reviewed total',
    );
  });
});
