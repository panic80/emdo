/** Tiny genuine PDF fixture with real page/content objects and cross-reference offsets.
 * Empty text pages contain an embedded raster image, exercising a no-text PDF path.
 */
export function financePdfFixture(
  pageLines: string[][] = [
    ['Date  Amount CAD', '2026-09-13  1234.500'],
    ['Units  USD', '2.50  89.00'],
  ],
  withDocumentAction = false,
) {
  const objects: string[] = [
    `<< /Type /Catalog /Pages 2 0 R ${withDocumentAction ? '/OpenAction << /S /JavaScript /JS (while\\(true\\) {} ) >>' : ''} >>`,
    `<< /Type /Pages /Kids [${pageLines.map((_, i) => `${5 + i * 2} 0 R`).join(' ')}] /Count ${pageLines.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length 9 >>\nstream\n00FF00FF>\nendstream',
  ];
  pageLines.forEach((lines, index) => {
    const content = lines.length
      ? lines
          .map(
            (line, i) =>
              `BT /F1 12 Tf 1 0 0 1 40 ${740 - i * 24} Tm (${line.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)')}) Tj ET`,
          )
          .join('\n')
      : 'q 100 0 0 100 40 600 cm /Im0 Do Q';
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> /XObject << /Im0 4 0 R >> >> /Contents ${6 + index * 2} 0 R >>`,
    );
    objects.push(
      `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    );
  });
  let text = '%PDF-1.7\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(text));
    text += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const start = Buffer.byteLength(text);
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(text);
}
