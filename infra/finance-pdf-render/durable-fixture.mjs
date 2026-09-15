import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { deflateSync } from 'node:zlib';
import { writeFile } from 'node:fs/promises';
const require = createRequire(
  new URL('../../apps/worker/package.json', import.meta.url),
);
const canvasRequire = createRequire(require.resolve('pdfjs-dist/package.json'));
const { createCanvas, loadImage } = canvasRequire('@napi-rs/canvas');
const image = await loadImage(
  fileURLToPath(
    new URL('../finance-ocr/acceptance/statement.png', import.meta.url),
  ),
);
const canvas = createCanvas(image.width, image.height),
  context = canvas.getContext('2d');
context.fillStyle = 'white';
context.fillRect(0, 0, image.width, image.height);
context.drawImage(image, 0, 0);
const rgba = context.getImageData(0, 0, image.width, image.height).data,
  rgb = Buffer.alloc(image.width * image.height * 3);
for (let pixel = 0; pixel < image.width * image.height; pixel++)
  for (let channel = 0; channel < 3; channel++)
    rgb[pixel * 3 + channel] = rgba[pixel * 4 + channel];
const stream = (dictionary, data) =>
  Buffer.concat([
    Buffer.from(`<< ${dictionary} /Length ${data.length} >>\nstream\n`),
    data,
    Buffer.from('\nendstream'),
  ]);
const objects = [
  Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
  Buffer.from('<< /Type /Pages /Kids [5 0 R 7 0 R 9 0 R] /Count 3 >>'),
  Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
  stream(
    `/Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`,
    deflateSync(rgb),
  ),
  Buffer.from(
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 6 0 R >>',
  ),
  stream(
    '',
    Buffer.from(
      'BT /F1 12 Tf 1 0 0 1 40 740 Tm (Synthetic deposit statement: see original page 2) Tj ET',
    ),
  ),
  Buffer.from(
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${image.width / 2} ${image.height / 2}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 8 0 R >>`,
  ),
  stream(
    '',
    Buffer.from(
      `q ${image.width / 2} 0 0 ${image.height / 2} 0 0 cm /Im0 Do Q`,
    ),
  ),
  // This genuine oversized no-text page exceeds renderer dimensions and remains unresolved.
  Buffer.from(
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10000 10000] /Resources << >> /Contents 10 0 R >>',
  ),
  stream('', Buffer.from('')),
];
const chunks = [Buffer.from('%PDF-1.7\n')],
  offsets = [];
for (let i = 0; i < objects.length; i++) {
  offsets.push(chunks.reduce((n, b) => n + b.length, 0));
  chunks.push(
    Buffer.from(`${i + 1} 0 obj\n`),
    objects[i],
    Buffer.from('\nendobj\n'),
  );
}
const start = chunks.reduce((n, b) => n + b.length, 0);
chunks.push(
  Buffer.from(
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`,
  ),
);
await writeFile(process.argv[2], Buffer.concat(chunks));
