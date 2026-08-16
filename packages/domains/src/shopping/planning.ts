import {
  IdentifierSchema,
  OpaqueReferenceSchema,
  deepFreeze,
  type DeepReadonly,
} from '@emdo/contracts';
import { z } from 'zod';

import { isBoundedAcyclicData } from './bounded.js';
import { ShoppingItemSchema, type ShoppingItem } from './items.js';

const GroupingInputSchema = z.strictObject({
  items: z.array(ShoppingItemSchema).max(1_000),
  assignments: z
    .array(
      z.strictObject({
        itemId: OpaqueReferenceSchema,
        retailerId: IdentifierSchema,
      }),
    )
    .max(1_000),
});

export type RetailerShoppingGroup = DeepReadonly<{
  retailerId: string | null;
  items: ShoppingItem[];
}>;

export type RetailerGroupingResult =
  | DeepReadonly<{
      status: 'grouped';
      groups: RetailerShoppingGroup[];
    }>
  | DeepReadonly<{
      status: 'rejected';
      safeError: {
        code: 'shopping-grouping-invalid';
        message: 'The retailer grouping request is invalid.';
        retryable: false;
      };
    }>;

const invalidGrouping = (): RetailerGroupingResult =>
  deepFreeze({
    status: 'rejected',
    safeError: {
      code: 'shopping-grouping-invalid',
      message: 'The retailer grouping request is invalid.',
      retryable: false,
    },
  });

export const groupShoppingItemsByRetailer = (
  input: unknown,
): RetailerGroupingResult => {
  if (!isBoundedAcyclicData(input)) return invalidGrouping();
  try {
    const parsed = GroupingInputSchema.safeParse(input);
    if (!parsed.success) return invalidGrouping();

    const itemIds = parsed.data.items.map((item) => item.id);
    const assignmentIds = parsed.data.assignments.map(
      (assignment) => assignment.itemId,
    );
    const itemIdSet = new Set(itemIds);
    if (
      itemIdSet.size !== itemIds.length ||
      new Set(assignmentIds).size !== assignmentIds.length ||
      assignmentIds.some((itemId) => !itemIdSet.has(itemId))
    ) {
      return invalidGrouping();
    }

    const assignments = new Map(
      parsed.data.assignments.map((assignment) => [
        assignment.itemId,
        assignment.retailerId,
      ]),
    );
    const groups = new Map<string | null, ShoppingItem[]>();
    const lexicalCompare = (left: string, right: string): number =>
      left === right ? 0 : left < right ? -1 : 1;
    for (const shoppingItem of [...parsed.data.items].sort((left, right) =>
      lexicalCompare(left.id, right.id),
    )) {
      const retailerId =
        assignments.get(shoppingItem.id) ??
        shoppingItem.preferredRetailers[0] ??
        null;
      const group = groups.get(retailerId) ?? [];
      group.push(shoppingItem as ShoppingItem);
      groups.set(retailerId, group);
    }

    const orderedGroups = [...groups.entries()]
      .sort(([left], [right]) => {
        if (left === null) return right === null ? 0 : 1;
        if (right === null) return -1;
        return lexicalCompare(left, right);
      })
      .map(([retailerId, items]) => ({ retailerId, items }));

    return deepFreeze({ status: 'grouped' as const, groups: orderedGroups });
  } catch {
    return invalidGrouping();
  }
};
