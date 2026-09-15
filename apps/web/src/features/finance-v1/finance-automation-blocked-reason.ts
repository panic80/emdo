const messages: Readonly<Record<string, string>> = {
  'journal-draft-invalid-intent':
    'The saved journal-draft request is not valid. Prepare and review a new request before starting a new run.',
  'journal-draft-source-invalid':
    'The reviewed import no longer matches this journal-draft request. Review the current source, prepare a new request, and start a new run.',
  'journal-draft-authority-denied':
    'This run no longer has the required authorization. Ask an administrator to restore authorized access, then review a new request before starting a new run.',
  'finance-extraction-invalid-intent':
    'The saved extraction request is not valid. Prepare and review a new request before starting a new run.',
  'finance-extraction-source-invalid':
    'The document no longer matches this extraction request. Review the current original, prepare a new request, and start a new run.',
  'finance-extraction-source-or-authority-invalid':
    'The document or its access authorization no longer matches this run. Check the current original and ask an administrator to restore authorized access if needed, then review a new request before starting a new run.',
  'finance-extraction-ocr-unavailable':
    'Isolated OCR is unavailable. Ask an administrator to configure the isolated OCR service, then review a new extraction request before starting a new run.',
  'finance-extraction-pdf-ocr-unavailable':
    'Isolated PDF rendering or OCR is unavailable. Ask an administrator to configure the required isolated services, then review a new extraction request before starting a new run.',
  'finance-extraction-format-unsupported':
    'This document format is not supported for extraction. Choose a supported original document and review a new extraction request before starting a new run.',
  'finance-extraction-source-limit':
    'The document exceeds the supported extraction limits. Review the original and the supported document limits before preparing a new extraction request.',
};
/** Unknown historical reasons remain inert text at React rendering call sites. */
export function financeAutomationBlockedReason(reason: string): string {
  return Object.hasOwn(messages, reason) ? messages[reason]! : reason;
}
