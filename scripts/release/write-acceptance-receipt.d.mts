import type { AcceptanceEvidenceContext } from './acceptance-evidence.mjs';

export function writeValidatedAcceptanceReceiptAndDescriptor(
  input: Readonly<{
    receiptsRoot: string;
    category: 'ci' | 'gates' | 'providers';
    id: string;
    receipt: unknown;
    context?: AcceptanceEvidenceContext;
  }>,
): Promise<
  Readonly<{
    artifactName: string;
    artifactPath: string;
    descriptorPath: string;
  }>
>;
