import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import type { FinancePage } from '@emdo/contracts/browser';

import { Button } from '../components/button.js';
import { Page, PageHeader } from '../components/page.js';
import { AskComposer } from '../features/chat/ask-composer.js';
import { useConversation } from '../features/chat/conversation.js';
import { useDomainData } from '../features/domains/domain-data.js';
import { DomainSyncStatus } from '../features/domains/domain-status.js';
import { useExperienceApi } from '../features/experience/experience-api.js';

const ManualTransactionSchema = z.object({
  description: z.string().trim().min(1, 'Enter a description.').max(160),
  category: z.string().trim().min(1, 'Enter a category.').max(80),
  amount: z
    .string()
    .trim()
    .regex(
      /^\d{1,9}(?:\.\d{1,2})?$/u,
      'Enter a CAD amount with up to two decimal places.',
    ),
  postedOn: z.string().date(),
});

type ManualTransactionValues = z.input<typeof ManualTransactionSchema>;

const StoredTransactionBaseSchema = z.object({
  description: z.string().trim().min(1).max(2_000),
  category: z.string().trim().min(1).max(200),
  postedOn: z.string().date(),
});
const StoredTransactionSchema = z.union([
  StoredTransactionBaseSchema.extend({
    amountCadMinor: z.number().int().safe(),
  }),
  StoredTransactionBaseSchema.extend({
    effectiveAmountCadMinor: z.number().int().safe(),
  }),
]);

const StoredBudgetSchema = z.object({
  id: z.string().trim().min(1).max(512),
  currency: z.literal('CAD'),
  allocationsCadMinor: z.record(
    z.string().regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u),
    z.number().int().safe().nonnegative(),
  ),
});

export function cadInputToMinorUnits(value: string): number {
  const match = /^(\d{1,9})(?:\.(\d{1,2}))?$/u.exec(value.trim());
  if (!match) throw new Error('Invalid CAD amount');
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? '').padEnd(2, '0'));
  const result = whole * 100 + fraction;
  if (!Number.isSafeInteger(result))
    throw new Error('CAD amount is outside safe bounds');
  return result;
}

export function localDateInputValue(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatCadMinor(value: number): string {
  const sign = value < 0 ? '-' : '';
  const absolute = Math.abs(value);
  return `${sign}$${Math.floor(absolute / 100).toLocaleString('en-CA')}.${String(absolute % 100).padStart(2, '0')}`;
}

export function FinanceRoute() {
  const api = useExperienceApi();
  const conversation = useConversation();
  const domain = useDomainData();
  const financeController = useRef<AbortController | undefined>(undefined);
  const [financePage, setFinancePage] = useState<FinancePage>();
  const [financeState, setFinanceState] = useState<
    'loading' | 'ready' | 'unavailable'
  >('loading');
  const [transactionOpen, setTransactionOpen] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<ManualTransactionValues>({
    resolver: zodResolver(ManualTransactionSchema),
    defaultValues: {
      description: '',
      category: '',
      amount: '',
      postedOn: localDateInputValue(new Date()),
    },
  });

  const loadFinance = (cursor?: string) => {
    financeController.current?.abort();
    const controller = new AbortController();
    financeController.current = controller;
    setFinanceState('loading');
    void api
      .listFinance(
        { ...(cursor ? { cursor } : {}), limit: 25 },
        { signal: controller.signal },
      )
      .then(
        (page) => {
          if (controller.signal.aborted) return;
          setFinancePage((current) =>
            cursor && current
              ? { ...page, items: [...current.items, ...page.items] }
              : page,
          );
          setFinanceState('ready');
        },
        () => {
          if (!controller.signal.aborted) setFinanceState('unavailable');
        },
      );
  };

  useEffect(() => {
    loadFinance();
    return () => financeController.current?.abort();
  }, [api]);

  const localTransactions = domain.records.flatMap((record) => {
    if (record.entityType !== 'finance.transaction' || record.tombstoned)
      return [];
    const parsed = StoredTransactionSchema.safeParse(record.value);
    if (!parsed.success) return [];
    const amountCadMinor =
      'amountCadMinor' in parsed.data
        ? parsed.data.amountCadMinor
        : parsed.data.effectiveAmountCadMinor;
    return [
      {
        id: record.id,
        date: parsed.data.postedOn.slice(5),
        description: parsed.data.description,
        category: parsed.data.category,
        amount: formatCadMinor(amountCadMinor),
      } as const,
    ];
  });
  const localBudgets = domain.records.flatMap((record) => {
    if (record.entityType !== 'finance.budget' || record.tombstoned) return [];
    const parsed = StoredBudgetSchema.safeParse(record.value);
    if (!parsed.success) return [];
    const allocatedCadMinor = Object.values(
      parsed.data.allocationsCadMinor,
    ).reduce((total, allocation) => total + allocation, 0);
    if (!Number.isSafeInteger(allocatedCadMinor)) return [];
    return [
      { id: record.id, label: parsed.data.id, allocatedCadMinor } as const,
    ];
  });
  const recordsReady =
    domain.state === 'ready' || domain.state === 'offline-ready';
  const serverTransactions = (financePage?.items ?? []).flatMap((item) =>
    item.recordType === 'transaction'
      ? [
          {
            id: item.id,
            date: item.postedOn.slice(5),
            description: item.description,
            category: item.category,
            amount: formatCadMinor(item.amountCadMinor),
          } as const,
        ]
      : [],
  );
  const serverBudgets = (financePage?.items ?? []).flatMap((item) => {
    if (item.recordType !== 'budget') return [];
    const allocatedCadMinor = Object.values(item.allocationsCadMinor).reduce(
      (total, allocation) => total + allocation,
      0,
    );
    if (!Number.isSafeInteger(allocatedCadMinor)) return [];
    return [{ id: item.id, label: item.id, allocatedCadMinor } as const];
  });
  const storedTransactions = [
    ...new Map(
      [...serverTransactions, ...localTransactions].map((item) => [
        item.id,
        item,
      ]),
    ).values(),
  ];
  const storedBudgets = [
    ...new Map(
      [...serverBudgets, ...localBudgets].map((item) => [item.id, item]),
    ).values(),
  ];
  return (
    <Page>
      <PageHeader
        title="Finance"
        description="Manual accounts and budgeting in CAD. No bank connections or payments."
      />
      <AskComposer
        compact
        onSubmit={async (message) => {
          await conversation.submit(message, 'finance');
        }}
      />
      <DomainSyncStatus />
      {financeState === 'unavailable' && !recordsReady ? (
        <p className="inline-error" role="status">
          Finance data is unavailable.
        </p>
      ) : null}
      {transactionOpen ? (
        <form
          className="transaction-form"
          noValidate
          onSubmit={handleSubmit(async (values) => {
            setSaveError(undefined);
            try {
              const amountCadMinor = cadInputToMinorUnits(values.amount);
              await domain.applyMutation({
                domain: 'finance',
                entityType: 'finance.transaction',
                entityId: `manual-${crypto.randomUUID()}`,
                kind: 'create',
                data: {
                  recordType: 'transaction',
                  description: values.description,
                  category: values.category,
                  amountCadMinor,
                  currency: 'CAD',
                  postedOn: values.postedOn,
                  source: 'manual',
                },
                actorIntent: 'Add a manual CAD transaction',
              });
              reset();
              setTransactionOpen(false);
            } catch {
              setSaveError(
                'The transaction could not be saved to encrypted offline data.',
              );
            }
          })}
        >
          <h2>Add manual transaction</h2>
          <label htmlFor="transaction-description">Description</label>
          <input id="transaction-description" {...register('description')} />
          {errors.description ? (
            <p className="field-error" role="alert">
              {errors.description.message}
            </p>
          ) : null}
          <label htmlFor="transaction-category">Category</label>
          <input id="transaction-category" {...register('category')} />
          {errors.category ? (
            <p className="field-error" role="alert">
              {errors.category.message}
            </p>
          ) : null}
          <label htmlFor="transaction-amount">Amount (CAD)</label>
          <input
            id="transaction-amount"
            inputMode="decimal"
            placeholder="0.00"
            {...register('amount')}
          />
          {errors.amount ? (
            <p className="field-error" role="alert">
              {errors.amount.message}
            </p>
          ) : null}
          <label htmlFor="transaction-date">Date</label>
          <input id="transaction-date" type="date" {...register('postedOn')} />
          {errors.postedOn ? (
            <p className="field-error" role="alert">
              {errors.postedOn.message}
            </p>
          ) : null}
          <div>
            <Button busy={isSubmitting} type="submit">
              Save transaction
            </Button>
            <Button
              variant="quiet"
              type="button"
              onClick={() => setTransactionOpen(false)}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
      {saveError ? (
        <p className="inline-error" role="alert">
          {saveError}
        </p>
      ) : null}
      <section className="finance-budgets" aria-labelledby="budget-heading">
        <div className="section-title-row">
          <h2 id="budget-heading">Budgets</h2>
          <span>CAD</span>
        </div>
        {storedBudgets.map((budget) => (
          <div className="budget-row" key={budget.id}>
            <strong>{budget.label}</strong>
            <span>{formatCadMinor(budget.allocatedCadMinor)} allocated</span>
          </div>
        ))}
        {recordsReady && storedBudgets.length === 0 ? (
          <p>No budgets have been saved yet.</p>
        ) : null}
        {domain.state === 'initializing' ? (
          <p>Budget data is loading…</p>
        ) : null}
        {!recordsReady && domain.state !== 'initializing' ? (
          <p>Budget data is unavailable while encrypted storage is locked.</p>
        ) : null}
      </section>
      <section className="open-section" aria-labelledby="transactions-heading">
        <div className="section-title-row">
          <h2 id="transactions-heading">Recent transactions</h2>
          <Button variant="quiet" onClick={() => setTransactionOpen(true)}>
            Add transaction
          </Button>
        </div>
        <div
          className="data-table"
          role="table"
          aria-label="Recent manual transactions"
        >
          {storedTransactions.map((transaction) => (
            <div role="row" key={transaction.id}>
              <span role="cell">{transaction.date}</span>
              <strong role="cell">{transaction.description}</strong>
              <span role="cell">{transaction.category}</span>
              <span role="cell">{transaction.amount}</span>
            </div>
          ))}
        </div>
        {recordsReady && storedTransactions.length === 0 ? (
          <p>No transactions have been saved yet.</p>
        ) : null}
        {domain.state === 'initializing' ? (
          <p>Transaction data is loading…</p>
        ) : null}
        {!recordsReady && domain.state !== 'initializing' ? (
          <p>
            Transaction data is unavailable while encrypted storage is locked.
          </p>
        ) : null}
      </section>
      {financePage?.nextCursor ? (
        <Button
          busy={financeState === 'loading'}
          onClick={() => loadFinance(financePage.nextCursor)}
          variant="quiet"
        >
          Load more finance records
        </Button>
      ) : null}
    </Page>
  );
}
