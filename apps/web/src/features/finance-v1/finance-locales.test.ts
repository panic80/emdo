import { afterEach, describe, expect, it } from 'vitest';

import {
  browserFinanceLocale,
  financeCopy,
  financeReviewLabel,
} from './finance-locales.js';
import type { FinanceLocale } from './finance-document-api.js';
import { experienceLocale } from './finance-experience-api.js';

const locales: readonly FinanceLocale[] = ['en-CA', 'fr-CA', 'ja-JP', 'ko-KR'];
const originalLanguage = Object.getOwnPropertyDescriptor(navigator, 'language');

function everyCopyValueIsPresent(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  if (value && typeof value === 'object') {
    return Object.values(value).every(everyCopyValueIsPresent);
  }
  return false;
}

afterEach(() => {
  if (originalLanguage)
    Object.defineProperty(navigator, 'language', originalLanguage);
  else Reflect.deleteProperty(navigator, 'language');
});

describe('Finance v1 locale catalog', () => {
  it('contains complete, non-empty copy for every supported locale', () => {
    expect(Object.keys(financeCopy)).toEqual(locales);
    for (const locale of locales) {
      expect(everyCopyValueIsPresent(financeCopy[locale])).toBe(true);
      expect(Object.keys(financeCopy[locale].views)).toEqual([
        'overview',
        'activity',
        'documents',
        'planning',
      ]);
    }
  });

  it('keeps the prescribed localized Finance view and accessible tab-list copy', () => {
    expect(financeCopy['en-CA'].views).toEqual({
      overview: 'Overview',
      activity: 'Activity',
      documents: 'Documents',
      planning: 'Planning',
    });
    expect(financeCopy['fr-CA'].views).toEqual({
      overview: 'Aperçu',
      activity: 'Activité',
      documents: 'Documents',
      planning: 'Planification',
    });
    expect(financeCopy['ja-JP'].views).toEqual({
      overview: '概要',
      activity: 'アクティビティ',
      documents: '書類',
      planning: '計画',
    });
    expect(financeCopy['ko-KR'].views).toEqual({
      overview: '개요',
      activity: '활동',
      documents: '문서',
      planning: '계획',
    });
    expect(financeCopy['fr-CA'].viewsAriaLabel).toBe('Vues de finances');
    expect(financeCopy['ja-JP'].viewsAriaLabel).toBe('ファイナンスの表示');
    expect(financeCopy['ko-KR'].viewsAriaLabel).toBe('금융 보기');
  });

  it('uses an exact browser locale and otherwise falls back to Canadian English', () => {
    for (const locale of locales) {
      Object.defineProperty(navigator, 'language', {
        configurable: true,
        value: locale,
      });
      expect(browserFinanceLocale()).toBe(locale);
    }
    Object.defineProperty(navigator, 'language', {
      configurable: true,
      value: 'fr',
    });
    expect(browserFinanceLocale()).toBe('en-CA');
  });

  it('localizes every review field family and safely falls back without exposing field identifiers', () => {
    expect(financeReviewLabel('en-CA', 'facts')).toBe('Extracted facts');
    expect(financeReviewLabel('fr-CA', 'issuer')).toBe('Émetteur');
    expect(financeReviewLabel('ja-JP', 'lineItems')).toBe('明細');
    expect(financeReviewLabel('ko-KR', 'proposedRecord')).toBe('제안된 기록');
    expect(financeReviewLabel('en-CA', 'paymentStatus')).toBe('Payment status');
    expect(financeReviewLabel('fr-CA', 'paymentStatus')).toBe(
      'État du paiement',
    );
    expect(financeReviewLabel('ja-JP', 'paymentStatus')).toBe('支払い状況');
    expect(financeReviewLabel('ko-KR', 'paymentStatus')).toBe('결제 상태');
    expect(financeCopy['en-CA'].paymentStatus).toEqual({
      unpaid: 'Unpaid',
      paid: 'Paid',
      unknown: 'Unknown',
    });
    expect(financeReviewLabel('fr-CA', 'unsafeInternalField')).toBe(
      financeCopy['fr-CA'].reviewFieldFallback,
    );
  });

  it('gives the saved Finance experience locale precedence over the browser locale', () => {
    expect(
      experienceLocale(
        { locale: 'ko-KR' } as Parameters<typeof experienceLocale>[0],
        'fr-CA',
      ),
    ).toBe('ko-KR');
    expect(experienceLocale(undefined, 'en-CA')).toBe('en-CA');
  });
});
