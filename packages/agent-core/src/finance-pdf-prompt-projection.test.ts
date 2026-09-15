import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { projectFinancePdfPrompt } from './finance-pdf-prompt-projection.js';

const digest = 'a'.repeat(64);
const sourceDigest = 'b'.repeat(64);
const facts = () => ({
  status: 'extracted',
  format: 'pdf',
  totalPages: 9,
  issues: [],
  pages: Array.from({ length: 9 }, (_, index) => ({
    page: index + 1,
    textStatus: 'text-extracted',
    text: `PAGE ${index + 1}\n` + 'é £ 001.2300\n'.repeat(120),
    spans: Array.from({ length: 200 }, () => ({
      text: 'synthetic',
      metadata: 'x'.repeat(180),
    })),
  })),
});

it('projects every page text verbatim without copying raw positional spans', () => {
  const raw = facts();
  const before = JSON.stringify(raw);
  expect(Buffer.byteLength(before)).toBeGreaterThan(262144);
  const projected = projectFinancePdfPrompt(raw, digest, sourceDigest, 50000)!;
  expect(projected).not.toBeNull();
  expect(projected.projection.pages).toEqual(
    raw.pages.map(({ page, textStatus, text }) => ({ page, textStatus, text })),
  );
  expect(projected.receipt).toMatchObject({
    kind: 'pdf-text.v1',
    extractionDigest: digest,
    pageCount: 9,
    spanCount: 1800,
    omittedPages: 0,
    textCharacters: raw.pages.reduce((n, p) => n + p.text.length, 0),
  });
  expect(projected.receipt.projectionDigest).toBe(
    createHash('sha256')
      .update(JSON.stringify(projected.projection))
      .digest('hex'),
  );
  expect(projected.projection.sourceDigest).toBe(sourceDigest);
  expect(JSON.stringify(raw)).toBe(before);
  expect(projectFinancePdfPrompt(raw, digest, sourceDigest, 50000)).toEqual(
    projected,
  );
});

it('uses exact UTF-8 serialized projection boundary and never drops a page to fit', () => {
  const raw = facts();
  const full = projectFinancePdfPrompt(raw, digest, sourceDigest, 50000)!;
  const bytes = Buffer.byteLength(JSON.stringify(full.projection), 'utf8');
  expect(projectFinancePdfPrompt(raw, digest, sourceDigest, bytes)).toEqual(
    full,
  );
  expect(
    projectFinancePdfPrompt(raw, digest, sourceDigest, bytes - 1),
  ).toBeNull();
});

it('rejects missing and duplicate page inventories and retains pages without text', () => {
  const raw = facts();
  expect(
    projectFinancePdfPrompt(
      { ...raw, pages: raw.pages.slice(1) },
      digest,
      sourceDigest,
      50000,
    ),
  ).toBeNull();
  expect(
    projectFinancePdfPrompt(
      { ...raw, pages: raw.pages.map((p) => ({ ...p, page: 1 })) },
      digest,
      sourceDigest,
      50000,
    ),
  ).toBeNull();
  raw.pages[4] = {
    ...raw.pages[4]!,
    text: '',
    textStatus: 'no-extractable-text',
    spans: [],
  };
  const projected = projectFinancePdfPrompt(raw, digest, sourceDigest, 50000)!;
  expect(projected.projection.pages[4]).toEqual({
    page: 5,
    text: '',
    textStatus: 'no-extractable-text',
  });
  expect(projected.receipt.omittedPages).toBe(0);
});
