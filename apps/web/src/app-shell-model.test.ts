import { describe, expect, it } from 'vitest';

import {
  DESKTOP_NAV_ITEMS,
  MOBILE_PRIMARY_ITEMS,
  MOBILE_SECONDARY_ITEMS,
  resolveNavigationState,
} from './app-shell-model.js';

describe('EMDO shell navigation', () => {
  it('exposes every approved desktop route in the accepted order', () => {
    expect(DESKTOP_NAV_ITEMS.map(({ label }) => label)).toEqual([
      'Today',
      'Ask EMDO',
      'Schedule',
      'Finance',
      'Shopping',
      'Approvals',
      'Activity',
      'Settings',
    ]);
  });

  it('uses five mobile destinations and keeps secondary destinations under More', () => {
    expect(MOBILE_PRIMARY_ITEMS.map(({ label }) => label)).toEqual([
      'Today',
      'Ask',
      'Schedule',
      'Finance',
      'More',
    ]);
    expect(MOBILE_SECONDARY_ITEMS.map(({ label }) => label)).toEqual([
      'Shopping',
      'Approvals',
      'Activity',
      'Settings',
    ]);
  });

  it('keeps More selected while naming the active secondary destination', () => {
    expect(resolveNavigationState('/approvals')).toEqual({
      activeDesktopId: 'approvals',
      activeMobileId: 'more',
      activeSecondaryLabel: 'Approvals',
    });
  });

  it('normalizes nested and root paths without trusting unknown routes', () => {
    expect(resolveNavigationState('/schedule/event-1').activeDesktopId).toBe(
      'schedule',
    );
    expect(resolveNavigationState('/')).toEqual({
      activeDesktopId: 'today',
      activeMobileId: 'today',
    });
    expect(resolveNavigationState('/not-a-route')).toEqual({
      activeDesktopId: 'today',
      activeMobileId: 'today',
    });
  });
});
