import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { FinanceDocumentApi } from '../finance-v1/finance-document-api.js';

const { createTurnMock, readRunEventsMock } = vi.hoisted(() => ({
  createTurnMock: vi.fn(),
  readRunEventsMock: vi.fn(),
}));

vi.mock('../auth/auth-context.js', () => ({
  useAuth: () => ({ csrfToken: 'csrf-current' }),
}));

vi.mock('../locale/locale-preference.js', () => ({
  useActiveLocale: () => 'en-CA',
}));

vi.mock('./ask-composer.js', () => ({
  AskComposer: ({
    onSubmit,
  }: {
    readonly onSubmit: (message: string) => void;
  }) => (
    <button type="button" onClick={() => onSubmit('What was the total?')}>
      Send finance question
    </button>
  ),
}));

vi.mock('../voice/voice-panel.js', () => ({ VoicePanel: () => null }));

vi.mock('./sse-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sse-client.js')>();
  return {
    ...actual,
    createTurn: createTurnMock,
    readRunEvents: readRunEventsMock,
  };
});

import { ConversationPanel, ConversationProvider } from './conversation.js';

const excerpt = `Reviewed CAD total ${'x'.repeat(600)} OMITTED-EVIDENCE-TAIL`;

function financeDocumentApi(): FinanceDocumentApi {
  return {
    list: vi.fn(async () => ({ schemaVersion: 1 as const, items: [] })),
    upload: vi.fn(async () => {
      throw new Error('not used');
    }),
    readDetail: vi.fn(async () => {
      throw new Error('not used');
    }),
    originalUrl: vi.fn(() => '/not-used'),
    readReview: vi.fn(async () => {
      throw new Error('not used');
    }),
    updateReview: vi.fn(async () => {
      throw new Error('not used');
    }),
    readMatches: vi.fn(async () => ({ schemaVersion: 1 as const, items: [] })),
    readEvidence: vi.fn(async () => ({
      schemaVersion: 1 as const,
      items: [
        {
          id: 'evidence-a',
          documentId: 'document-a',
          extractionRevision: 1,
          page: 2,
          excerpt,
          sourceLocale: 'fr-CA' as const,
          locator: { kind: 'text', characterStart: 0, characterEnd: 10 },
        },
      ],
    })),
    retry: vi.fn(async () => {
      throw new Error('not used');
    }),
  };
}

describe('ConversationPanel finance evidence', () => {
  beforeEach(() => {
    createTurnMock.mockResolvedValue({
      schemaVersion: 1,
      runId: 'run-a',
      status: 'accepted',
      replayed: false,
      eventsPath: '/api/v1/runs/run-a/events',
    });
    readRunEventsMock.mockImplementation(async function* () {
      yield {
        id: 'event-1',
        type: 'run.completed',
        data: {
          schemaVersion: 1,
          runId: 'run-a',
          sequence: 1,
          type: 'run.completed',
          occurredAt: '2026-08-27T12:00:00.000Z',
          data: {
            status: 'completed',
            runId: 'run-a',
            output: {
              summary: 'The reviewed total is CAD 12.00.',
              evidenceReferences: [
                'evidence-a',
                'evidence-a',
                'scheduler-evidence',
                'manager-only-evidence',
              ],
            },
            specialistOutcomes: [
              {
                specialistId: 'finance',
                status: 'completed',
                output: { evidenceReferences: ['evidence-a'] },
              },
              {
                specialistId: 'scheduler',
                status: 'completed',
                output: { evidenceReferences: ['scheduler-evidence'] },
              },
            ],
          },
        },
      };
    });
  });

  it('parses completed Finance evidence, reads it on click, and only renders a bounded preview', async () => {
    const api = financeDocumentApi();
    const storageGet = vi.spyOn(Storage.prototype, 'getItem');
    const storageSet = vi.spyOn(Storage.prototype, 'setItem');
    const user = userEvent.setup();
    render(
      <ConversationProvider>
        <ConversationPanel specialist="finance" financeDocumentApi={api} />
      </ConversationProvider>,
    );

    await user.click(
      screen.getByRole('button', { name: 'Send finance question' }),
    );
    expect(
      await screen.findByText('The reviewed total is CAD 12.00.'),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Sources 1' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Sources 2' })).toBeNull();
    expect(document.body.textContent).not.toContain('scheduler-evidence');

    await user.click(screen.getByRole('button', { name: 'Sources 1' }));
    await waitFor(() =>
      expect(api.readEvidence).toHaveBeenCalledWith('evidence-a'),
    );
    expect(
      await screen.findByText('Page 2 · Source language: fr-CA'),
    ).toBeVisible();
    expect(screen.getByText(`${excerpt.slice(0, 500)}…`)).toBeVisible();
    expect(document.body.textContent).not.toContain('OMITTED-EVIDENCE-TAIL');
    expect(storageGet).not.toHaveBeenCalled();
    expect(storageSet).not.toHaveBeenCalled();
  });
});
