export function runAcceptanceDescriptorWrite(argv: readonly string[]): Promise<
  Readonly<{
    output: string;
    artifact: Readonly<{ name: string; sha256: string }>;
  }>
>;
