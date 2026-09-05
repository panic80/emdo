import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createFinanceDocumentApi } from './finance-document-api.js';

const token = 'A'.repeat(43);
const summary = {
  schemaVersion: 1 as const,
  id: 'document-a',
  documentType: 'receipt',
  displayName: 'Receipt.pdf',
  mimeType: 'application/pdf' as const,
  byteSize: 2048,
  plaintextSha256: 'a'.repeat(64),
  sourceLocale: 'en-CA' as const,
  currency: 'CAD',
  extractionRevision: 1,
  state: 'awaiting-review' as const,
  createdAt: '2026-08-26T12:00:00.000Z',
  updatedAt: '2026-08-26T12:00:00.000Z',
};

const webRoot = (): string => {
  const workingDirectory = process.cwd();
  return basename(workingDirectory) === 'web' &&
    basename(dirname(workingDirectory)) === 'apps'
    ? workingDirectory
    : resolve(workingDirectory, 'apps/web');
};

const response = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  });

describe('Finance v1 offline/browser persistence exclusion', () => {
  it('keeps document payloads, unreviewed extraction, evidence text, and embeddings out of durable browser storage', async () => {
    const fetcher = vi.fn(async (path: string) => {
      if (path.endsWith('/review')) {
        return response({
          schemaVersion: 1,
          documentId: 'document-a',
          extractionRevision: 1,
          envelope: {
            schemaVersion: 1,
            documentType: 'receipt',
            sourceLocale: 'en-CA',
            currency: 'CAD',
            total: { currency: 'CAD', minorUnits: 1234 },
          },
          payloadHash: 'b'.repeat(64),
          reviewToken: token,
          expiresAt: '2026-08-26T13:00:00.000Z',
        });
      }
      if (path.includes('/finance/evidence/')) {
        return response({
          schemaVersion: 1,
          items: [
            {
              id: 'evidence-a',
              documentId: 'document-a',
              extractionRevision: 1,
              page: 1,
              excerpt: 'full evidence text must not enter browser persistence',
              sourceLocale: 'en-CA',
              locator: { kind: 'text', characterStart: 0, characterEnd: 10 },
              embedding: [0.1, 0.2],
            },
          ],
        });
      }
      return response({
        schemaVersion: 1,
        items: [
          {
            ...summary,
            original: 'raw-original-file-bytes',
            uploadBytes: 'raw-upload-bytes',
            unreviewedExtraction: { fullText: 'unreviewed extraction' },
            fullEvidenceText: 'full evidence text',
            embedding: [0.1, 0.2],
          },
        ],
      });
    });
    const storageGet = vi.spyOn(Storage.prototype, 'getItem');
    const storageSet = vi.spyOn(Storage.prototype, 'setItem');
    const indexedDbOpen = vi.fn();
    const cacheOpen = vi.fn();
    vi.stubGlobal('indexedDB', { open: indexedDbOpen });
    vi.stubGlobal('caches', { open: cacheOpen });
    try {
      const api = createFinanceDocumentApi({
        fetcher: fetcher as typeof fetch,
      });

      const documents = await api.list();
      await api.readReview('document-a');
      await api.readEvidence('evidence-a');

      expect(documents.items).toEqual([summary]);
      expect(storageGet).not.toHaveBeenCalled();
      expect(storageSet).not.toHaveBeenCalled();
      expect(indexedDbOpen).not.toHaveBeenCalled();
      expect(cacheOpen).not.toHaveBeenCalled();
      expect(fetcher.mock.calls).toEqual(
        expect.arrayContaining([
          [
            '/api/v1/finance/documents',
            expect.objectContaining({ cache: 'no-store' }),
          ],
          [
            '/api/v1/finance/documents/document-a/review',
            expect.objectContaining({ cache: 'no-store' }),
          ],
          [
            '/api/v1/finance/evidence/evidence-a',
            expect.objectContaining({ cache: 'no-store' }),
          ],
        ]),
      );
    } finally {
      vi.unstubAllGlobals();
      storageGet.mockRestore();
      storageSet.mockRestore();
    }
  });

  it('does not let Finance-v1 code reach browser persistence primitives', async () => {
    const financeRoot = resolve(webRoot(), 'src/features/finance-v1');
    const sourceFiles = (await readdir(financeRoot)).filter(
      (file) =>
        /\.(?:ts|tsx)$/u.test(file) &&
        !file.endsWith('.test.ts') &&
        !file.endsWith('.test.tsx'),
    );
    const sources = await Promise.all(
      sourceFiles.map(
        async (file) =>
          [file, await readFile(resolve(financeRoot, file), 'utf8')] as const,
      ),
    );

    for (const [file, source] of sources) {
      expect(source, file).not.toMatch(
        /\b(?:indexedDB|localStorage|sessionStorage|CacheStorage|caches|OPFS|PowerSync)\b|URL\.createObjectURL/u,
      );
    }

    const documentApi = sources.find(
      ([file]) => file === 'finance-document-api.ts',
    )?.[1];
    expect(documentApi).toContain('held only in React memory');
  });

  it('keeps service-worker and PowerSync persistence limited to static assets and canonical records, while retaining localized and reviewed finance UI data', async () => {
    const root = webRoot();
    const [serviceWorker, viteConfig, syncRules, financeRoute] =
      await Promise.all([
        readFile(resolve(root, 'src/sw.ts'), 'utf8'),
        readFile(resolve(root, 'vite.config.ts'), 'utf8'),
        readFile(
          resolve(root, '../../infra/powersync/sync-rules.yaml'),
          'utf8',
        ),
        readFile(resolve(root, 'src/routes/finance.tsx'), 'utf8'),
      ]);

    expect(serviceWorker).toContain("event.request.mode !== 'navigate'");
    expect(serviceWorker).not.toMatch(/registerRoute|cache\.put|caches\.open/u);
    expect(viteConfig).toContain(
      "globPatterns: ['**/*.{js,css,html,ico,png,svg,webp,woff2,wasm}']",
    );
    expect(syncRules).toContain('"emdo"."sync_entities"');
    expect(syncRules).not.toMatch(
      /finance_documents|finance_document_extractions|finance_document_chunks|finance_document_evidence|embedding/u,
    );

    expect(financeRoute).toContain('useActiveLocale()');
    expect(financeRoute).toContain(
      '<ConversationPanel specialist="finance" />',
    );
    expect(financeRoute).toContain(
      "record.entityType !== 'finance.transaction'",
    );
    expect(financeRoute).toContain("record.entityType !== 'finance.budget'");
  });
});
