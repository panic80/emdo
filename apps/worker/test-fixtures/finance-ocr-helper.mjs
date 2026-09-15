import { createHash } from 'node:crypto';

const input = await new Promise((resolve, reject) => {
  const chunks = [];
  process.stdin.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
  process.stdin.once('error', reject);
  process.stdin.once('end', () => resolve(Buffer.concat(chunks)));
});

const separator = input.indexOf(Buffer.from('\n\n', 'ascii'));
if (separator < 0) process.exit(74);
const headerText = input.subarray(0, separator).toString('ascii');
const payload = input.subarray(separator + 2);
const lines = headerText.split('\n');
if (lines.shift() !== 'EMDO-FINANCE-OCR-HELPER-V1') process.exit(74);
const headers = new Map();
for (const line of lines) {
  const index = line.indexOf('=');
  if (index <= 0) process.exit(74);
  headers.set(line.slice(0, index), line.slice(index + 1));
}
const sourceLength = Number(headers.get('source-length'));
const payloadLength = Number(headers.get('payload-length'));
const source = payload.subarray(0, sourceLength);
const stagePayload = payload.subarray(
  sourceLength,
  sourceLength + payloadLength,
);
if (source.length !== sourceLength || stagePayload.length !== payloadLength)
  process.exit(74);
if (
  headers.get('source-check') === 'required' &&
  createHash('sha256').update(source).digest('hex') !==
    headers.get('source-sha256')
)
  process.exit(74);

const manifest = {
  magick: {
    path: '/usr/local/bin/magick',
    sha256: 'a'.repeat(64),
  },
  tesseract: {
    path: '/usr/bin/tesseract',
    sha256: 'b'.repeat(64),
    version: '5.5.1',
  },
  trainedData: [
    {
      language: 'eng',
      path: '/usr/share/tesseract-ocr/5/tessdata/eng.traineddata',
      sha256: 'c'.repeat(64),
    },
  ],
};
const operation = headers.get('operation');
const width = 100;
const height = 50;
const pgm = Buffer.concat([
  Buffer.from(`P5\n${width} ${height}\n255\n`, 'ascii'),
  Buffer.alloc(width * height, 255),
]);
const tsv =
  'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n' +
  '5\t1\t1\t1\t1\t1\t10\t10\t60\t15\t95.0\tDate\n';
let result = Buffer.alloc(0);
let decoded = Buffer.alloc(0);
if (operation === 'identify')
  result = Buffer.from('PNG 100 50 Undefined 1\n', 'ascii');
else if (operation === 'describe')
  result = Buffer.from(
    JSON.stringify({
      id: 'tesseract',
      version: '5.5.1',
      languages: ['eng'],
      trainedData: [{ language: 'eng', sha256: 'c'.repeat(64) }],
    }),
    'utf8',
  );
else if (operation === 'decode') decoded = pgm;
else if (operation === 'recognize') result = Buffer.from(tsv, 'utf8');
else if (operation !== 'verify') process.exit(74);

const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
const responseHeader = Buffer.from(
  [
    'EMDO-FINANCE-OCR-HELPER-V1-RESPONSE',
    'status=ok',
    `operation=${operation}`,
    `source-sha256=${headers.get('source-sha256')}`,
    `manifest-length=${manifestBytes.length}`,
    `result-length=${result.length}`,
    `pgm-length=${decoded.length}`,
    '',
    '',
  ].join('\n'),
  'ascii',
);
process.stdout.write(
  Buffer.concat([responseHeader, manifestBytes, result, decoded]),
);
