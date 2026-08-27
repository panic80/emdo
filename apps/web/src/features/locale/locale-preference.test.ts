import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  browserExactLocale,
  readActiveLocale,
  setActiveLocale,
} from './locale-preference.js';

const originalLanguage = Object.getOwnPropertyDescriptor(navigator, 'language');
const originalStorage = Object.getOwnPropertyDescriptor(window, 'localStorage');
let values = new Map<string, string>();

beforeEach(() => {
  values = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    },
  });
});

afterEach(() => {
  if (originalStorage !== undefined) {
    Object.defineProperty(window, 'localStorage', originalStorage);
  }
  if (originalLanguage !== undefined) {
    Object.defineProperty(navigator, 'language', originalLanguage);
  }
});

describe('active locale preference', () => {
  it('uses only exact supported browser locales and falls back to Canadian English', () => {
    expect(browserExactLocale('fr-CA')).toBe('fr-CA');
    expect(browserExactLocale('fr')).toBe('en-CA');
    expect(browserExactLocale('en-US')).toBe('en-CA');
  });

  it('persists the Settings locale override locally for offline turn submission', () => {
    Object.defineProperty(navigator, 'language', {
      configurable: true,
      value: 'ja-JP',
    });
    expect(readActiveLocale()).toBe('ja-JP');

    setActiveLocale('ko-KR');

    expect(values.get('emdo.active-locale.v1')).toBe('ko-KR');
    expect(readActiveLocale()).toBe('ko-KR');
  });
});
