import { createRequire } from 'node:module';
import { renderFinancePdfPage } from '../../packages/integrations/src/finance-documents/pdf-page-render.ts';
const requestMagic = Buffer.from('EMDO-FINANCE-PDF-RENDER-V1\n');
const responseMagic = Buffer.from('EMDO-FINANCE-PDF-RENDER-V1-RESPONSE\n');
const maxBytes = 2 * 1024 * 1024;
const require = createRequire(import.meta.url);
const runtime = {
  pdfjsVersion: require('pdfjs-dist/package.json').version,
  canvasVersion: require('@napi-rs/canvas/package.json').version,
};
if (runtime.pdfjsVersion !== '5.4.296' || runtime.canvasVersion !== '0.1.80')
  process.exit(74);
// Suppress runtime diagnostics; stdout is exclusively the binary protocol.
let size = 0;
const chunks = [];
const deadline = setTimeout(() => process.exit(74), 16000);
try {
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > maxBytes + 4096) throw new Error('request-limit');
    chunks.push(chunk);
  }
  const frame = Buffer.concat(chunks);
  if (
    !frame.subarray(0, requestMagic.length).equals(requestMagic) ||
    frame.length < requestMagic.length + 4
  )
    throw new Error('request-frame');
  const length = frame.readUInt32BE(requestMagic.length);
  if (
    length < 1 ||
    length > 2048 ||
    frame.length < requestMagic.length + 4 + length
  )
    throw new Error('request-header');
  const header = JSON.parse(
    frame
      .subarray(requestMagic.length + 4, requestMagic.length + 4 + length)
      .toString('utf8'),
  );
  if (
    !header ||
    Object.keys(header).sort().join(',') !==
      'byteLength,pageNumber,scale,sourceDigest' ||
    !Number.isInteger(header.byteLength) ||
    header.byteLength < 1 ||
    header.byteLength > maxBytes ||
    !Number.isInteger(header.pageNumber) ||
    header.pageNumber < 1 ||
    header.pageNumber > 25 ||
    typeof header.scale !== 'number' ||
    !Number.isFinite(header.scale) ||
    header.scale <= 0 ||
    header.scale > 4 ||
    typeof header.sourceDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(header.sourceDigest)
  )
    throw new Error('request-invalid');
  const bytes = frame.subarray(requestMagic.length + 4 + length);
  if (bytes.length !== header.byteLength) throw new Error('request-length');
  const result = await renderFinancePdfPage({
    bytes,
    expectedSourceDigest: header.sourceDigest,
    pageNumber: header.pageNumber,
    scale: header.scale,
  });
  const png =
    result.status === 'rendered' ? Buffer.from(result.png) : Buffer.alloc(0);
  const json = Buffer.from(
    JSON.stringify(
      result.status === 'rendered'
        ? {
            status: 'rendered',
            render: result.render,
            pngBytes: png.length,
            runtime,
          }
        : { ...result, pngBytes: 0, runtime },
    ),
  );
  if (json.length > 2048 || png.length > maxBytes)
    throw new Error('response-limit');
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(json.length);
  process.stdout.write(Buffer.concat([responseMagic, prefix, json, png]));
} catch {
  process.exitCode = 74;
} finally {
  clearTimeout(deadline);
}
