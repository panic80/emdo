export function runAcceptanceEvidenceAssembly(
  argv: readonly string[],
  now?: number,
): Promise<Readonly<{ gateCount: number; providerCount: number }>>;
