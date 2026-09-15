import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { financePdfFixture } from '../../../packages/integrations/src/finance-documents/test-fixtures/pdf.js';
import { FINANCE_PDF_REPORT_LIMITS } from '../../../packages/integrations/src/finance-documents/pdf-report-extraction.js';

describe('standardization worker production artifact', () => {
  it('boots without credentials and extracts genuine PDF text in the emitted isolated worker', () => {
    const cwd = fileURLToPath(new URL('../', import.meta.url));
    execFileSync(process.execPath, ['build.mjs'], { cwd, stdio: 'pipe' });
    const script = `import { Worker } from 'node:worker_threads';
      const worker = new Worker(new URL('./dist/pdf-report-worker.js', import.meta.url), {workerData:{bytes:new Uint8Array(Buffer.from(${JSON.stringify(financePdfFixture().toString('base64'))},'base64')),limits:${JSON.stringify(FINANCE_PDF_REPORT_LIMITS)}},execArgv:[],stdout:true,stderr:true});
      worker.stdout.resume();worker.stderr.resume();
      const timer=setTimeout(()=>{void worker.terminate();process.exitCode=1;},10000);
      worker.once('message',async result=>{clearTimeout(timer);await worker.terminate();console.log(JSON.stringify(result));});
      worker.once('error',()=>{clearTimeout(timer);process.exitCode=1;});`;
    const result = JSON.parse(
      execFileSync(
        process.execPath,
        ['--input-type=module', '--eval', script],
        { cwd, encoding: 'utf8', stdio: 'pipe' },
      ),
    );
    expect(result.status).toBe('extracted');
    expect(result.totalPages).toBe(2);
    expect(result.pages[0].text).toContain('1234.500');
  }, 30000);
});
