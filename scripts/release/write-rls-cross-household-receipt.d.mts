export function runRlsCrossHouseholdReceiptWrite(
  argv: readonly string[],
  options?: Readonly<{
    environment?: Readonly<Record<string, string | undefined>>;
    now?: () => Date;
  }>,
): Promise<Readonly<Record<string, unknown>>>;
