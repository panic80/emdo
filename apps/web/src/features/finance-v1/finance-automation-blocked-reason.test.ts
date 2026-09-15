import { describe, expect, it } from 'vitest';
import { financeAutomationBlockedReason } from './finance-automation-blocked-reason.js';
describe('saved automation block explanations', () => {
  it.each([
    'journal-draft-source-invalid',
    'finance-extraction-source-invalid',
  ])('requires new source review for %s', (code) => {
    expect(financeAutomationBlockedReason(code)).toMatch(/Review the current/);
    expect(financeAutomationBlockedReason(code)).toContain('new run');
  });
  it.each([
    'journal-draft-invalid-intent',
    'finance-extraction-invalid-intent',
  ])('requires a reviewed new request for %s', (code) =>
    expect(financeAutomationBlockedReason(code)).toContain(
      'Prepare and review a new request',
    ),
  );
  it.each([
    'journal-draft-authority-denied',
    'finance-extraction-source-or-authority-invalid',
  ])('directs authorized access recovery for %s', (code) =>
    expect(financeAutomationBlockedReason(code)).toContain(
      'restore authorized access',
    ),
  );
  it.each([
    'finance-extraction-ocr-unavailable',
    'finance-extraction-pdf-ocr-unavailable',
  ])('identifies isolated service setup for %s', (code) =>
    expect(financeAutomationBlockedReason(code)).toContain('configure'),
  );
  it.each([
    'finance-extraction-format-unsupported',
    'finance-extraction-source-limit',
  ])('explains the supported document boundary for %s', (code) =>
    expect(financeAutomationBlockedReason(code)).toContain('supported'),
  );
  it.each([
    'historical-worker-reason',
    '<script>alert(1)</script>',
    'toString',
  ])('preserves unknown historical text %s', (reason) =>
    expect(financeAutomationBlockedReason(reason)).toBe(reason),
  );
});
