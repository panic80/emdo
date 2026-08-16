import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';

import type { ShoppingPage } from '@emdo/contracts/browser';

import { Button } from '../components/button.js';
import { Icon } from '../components/icon.js';
import { Page, PageHeader } from '../components/page.js';
import { AskComposer } from '../features/chat/ask-composer.js';
import { useConversation } from '../features/chat/conversation.js';
import { useDomainData } from '../features/domains/domain-data.js';
import { DomainSyncStatus } from '../features/domains/domain-status.js';
import { useExperienceApi } from '../features/experience/experience-api.js';

const ShoppingItemValueSchema = z.object({
  name: z.string().trim().min(1).max(200),
  quantityMinorUnits: z.number().int().safe().nonnegative(),
  unit: z.string().trim().min(1).max(40),
  retailer: z.string().trim().min(1).max(200).optional(),
});

interface ShoppingItem {
  readonly id: string;
  readonly name: string;
  readonly quantityMinorUnits: number;
  readonly unit: string;
  readonly retailer?: string;
  readonly state: 'active' | 'needs-review';
  readonly editable: boolean;
}

const formatQuantity = (minorUnits: number): string => {
  const quantity = minorUnits / 1_000;
  return Number.isInteger(quantity)
    ? String(quantity)
    : quantity.toFixed(3).replace(/0+$/u, '').replace(/\.$/u, '');
};

export function ShoppingRoute() {
  const api = useExperienceApi();
  const conversation = useConversation();
  const domain = useDomainData();
  const controllerRef = useRef<AbortController | undefined>(undefined);
  const [page, setPage] = useState<ShoppingPage>();
  const [readState, setReadState] = useState<
    'loading' | 'ready' | 'unavailable'
  >('loading');
  const [busyItem, setBusyItem] = useState<string>();
  const [editError, setEditError] = useState<string>();

  const loadShopping = (cursor?: string) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setReadState('loading');
    void api
      .listShopping(
        { ...(cursor ? { cursor } : {}), limit: 25 },
        { signal: controller.signal },
      )
      .then(
        (next) => {
          if (controller.signal.aborted) return;
          setPage((current) =>
            cursor && current
              ? { ...next, items: [...current.items, ...next.items] }
              : next,
          );
          setReadState('ready');
        },
        () => {
          if (!controller.signal.aborted) setReadState('unavailable');
        },
      );
  };

  useEffect(() => {
    loadShopping();
    return () => controllerRef.current?.abort();
  }, [api]);

  const serverItems: ShoppingItem[] = (page?.items ?? []).map((item) => ({
    id: item.id,
    name: item.name ?? 'Unnamed item',
    quantityMinorUnits: item.quantityMinorUnits,
    unit: item.unit ?? 'units',
    ...(item.retailer ? { retailer: item.retailer } : {}),
    state: item.state,
    editable: false,
  }));
  const localItems: ShoppingItem[] = domain.records.flatMap((record) => {
    if (record.entityType !== 'shopping.item' || record.tombstoned) return [];
    const parsed = ShoppingItemValueSchema.safeParse(record.value);
    if (!parsed.success) return [];
    return [
      {
        id: record.id,
        ...parsed.data,
        state: 'active' as const,
        editable: true,
      },
    ];
  });
  const items = [
    ...new Map(
      [...serverItems, ...localItems].map((item) => [item.id, item]),
    ).values(),
  ];
  const retailerCount = new Set(
    items.flatMap(({ retailer }) => (retailer ? [retailer] : [])),
  ).size;
  const recordsReady =
    domain.state === 'ready' || domain.state === 'offline-ready';

  const changeQuantity = async (item: ShoppingItem, delta: number) => {
    if (!item.editable || item.quantityMinorUnits + delta * 1_000 < 0) return;
    setBusyItem(item.id);
    setEditError(undefined);
    try {
      await domain.applyMutation({
        domain: 'shopping',
        entityType: 'shopping.item',
        entityId: item.id,
        kind: 'delta',
        data: { quantityMinorUnits: delta * 1_000 },
        actorIntent: `${delta > 0 ? 'Increase' : 'Decrease'} ${item.name} quantity`,
      });
    } catch {
      setEditError(
        'That quantity change could not be saved to encrypted offline data.',
      );
    } finally {
      setBusyItem(undefined);
    }
  };

  return (
    <Page>
      <PageHeader
        title="Shopping"
        description="A bounded household list. Prices, checkout, and provider authority data are not exposed."
      />
      <AskComposer
        compact
        onSubmit={async (message) => {
          const result = await conversation.submit(message, 'shopping');
          if (result) loadShopping();
        }}
      />
      <DomainSyncStatus />
      {editError ? (
        <p className="inline-error" role="alert">
          {editError}
        </p>
      ) : null}
      <section
        className="shopping-plan"
        aria-labelledby="shopping-plan-heading"
      >
        <div className="section-title-row">
          <h2 id="shopping-plan-heading">Household list</h2>
          <span>
            {retailerCount > 0
              ? `${retailerCount} ${retailerCount === 1 ? 'retailer' : 'retailers'}`
              : 'No retailer data'}
          </span>
        </div>
        {items.map((item) => (
          <article className="shopping-item" key={item.id}>
            <div>
              <strong>{item.name}</strong>
              <span>
                {item.retailer ?? 'Retailer not selected'}
                {item.state === 'needs-review' ? ' · Needs review' : ''}
              </span>
            </div>
            <div
              className="quantity-control"
              aria-label={`${item.name} quantity`}
            >
              <button
                aria-label={`Decrease ${item.name}`}
                disabled={
                  !item.editable ||
                  busyItem === item.id ||
                  item.quantityMinorUnits === 0
                }
                onClick={() => void changeQuantity(item, -1)}
                type="button"
              >
                −
              </button>
              <span>
                {formatQuantity(item.quantityMinorUnits)} {item.unit}
              </span>
              <button
                aria-label={`Increase ${item.name}`}
                disabled={!item.editable || busyItem === item.id}
                onClick={() => void changeQuantity(item, 1)}
                type="button"
              >
                +
              </button>
            </div>
          </article>
        ))}
        {recordsReady && items.length === 0 ? (
          <p>No shopping items have been saved yet.</p>
        ) : null}
        {domain.state === 'initializing' && !page ? (
          <p>Shopping data is loading…</p>
        ) : null}
        {!recordsReady &&
        domain.state !== 'initializing' &&
        readState === 'unavailable' ? (
          <p>Shopping data is unavailable while encrypted storage is locked.</p>
        ) : null}
        {page?.nextCursor ? (
          <Button
            busy={readState === 'loading'}
            onClick={() => loadShopping(page.nextCursor)}
            variant="quiet"
          >
            Load more shopping items
          </Button>
        ) : null}
      </section>
      <section className="cost-summary" aria-labelledby="cost-summary-heading">
        <h2 id="cost-summary-heading">Pricing</h2>
        <p>
          <Icon name="info" size={20} /> Prices and external retailer links are
          intentionally omitted from this household projection.
        </p>
      </section>
    </Page>
  );
}
