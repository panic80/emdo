import { useSyncExternalStore } from 'react';

import {
  SupportedLocaleSchema,
  type SupportedLocale,
} from '@emdo/contracts/browser';

const STORAGE_KEY = 'emdo.active-locale.v1';
const FALLBACK_LOCALE: SupportedLocale = 'en-CA';
const listeners = new Set<() => void>();
let sessionLocale: SupportedLocale | undefined;

const notify = () => {
  for (const listener of listeners) listener();
};

export const browserExactLocale = (value: unknown): SupportedLocale => {
  const parsed = SupportedLocaleSchema.safeParse(value);
  return parsed.success ? parsed.data : FALLBACK_LOCALE;
};

const browserDefaultLocale = (): SupportedLocale =>
  typeof navigator === 'undefined'
    ? FALLBACK_LOCALE
    : browserExactLocale(navigator.language);

export const readActiveLocale = (): SupportedLocale => {
  if (sessionLocale !== undefined) return sessionLocale;
  if (typeof window === 'undefined') return browserDefaultLocale();
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === null
      ? browserDefaultLocale()
      : browserExactLocale(stored);
  } catch {
    return browserDefaultLocale();
  }
};

export const setActiveLocale = (locale: SupportedLocale): void => {
  const next = SupportedLocaleSchema.parse(locale);
  sessionLocale = next;
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // The active preference remains usable for this session when storage is locked.
    }
  }
  notify();
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) {
      sessionLocale = undefined;
      listener();
    }
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
};

export const useActiveLocale = (): SupportedLocale =>
  useSyncExternalStore(subscribe, readActiveLocale, () => FALLBACK_LOCALE);

export const ACTIVE_LOCALE_OPTIONS = Object.freeze([
  { value: 'en-CA' as const, label: 'English (Canada)' },
  { value: 'fr-CA' as const, label: 'Français (Canada)' },
  { value: 'ja-JP' as const, label: '日本語' },
  { value: 'ko-KR' as const, label: '한국어' },
]);
