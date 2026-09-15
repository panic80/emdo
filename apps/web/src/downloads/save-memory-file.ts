/** A user-requested download from memory. No browser database, cache or sync queue.
 * The short-lived object URL is always released, including when download setup fails.
 */
export function saveMemoryFile(
  filename: string,
  content: BlobPart,
  mimeType: string,
) {
  const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
