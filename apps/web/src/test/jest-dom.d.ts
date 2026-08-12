import 'vitest';

// The web package intentionally consumes the workspace's single Vitest 2
// installation. Vitest 2 builds assertions from the global Jest matcher
// contract, so bridge only the jest-dom methods used by this test suite.
// Runtime registration lives in setup.ts.
declare global {
  namespace jest {
    interface Matchers<R = void> {
      toBeChecked(): R;
      toBeDisabled(): R;
      toBeInTheDocument(): R;
      toBeVisible(): R;
      toHaveAccessibleName(expected?: string | RegExp): R;
      toHaveAttribute(name: string, value?: string | RegExp): R;
      toHaveTextContent(
        value: string | RegExp,
        options?: { normalizeWhitespace?: boolean },
      ): R;
    }
  }
}
