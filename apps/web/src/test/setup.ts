import * as jestDomMatchers from '@testing-library/jest-dom/matchers';
import { cleanup } from '@testing-library/react';
import { afterEach, expect, vi } from 'vitest';

type ExpectMatcher = Parameters<typeof expect.extend>[0][string];

const matchers = Object.fromEntries(
  Object.entries(jestDomMatchers).filter(
    (entry): entry is [string, ExpectMatcher] => typeof entry[1] === 'function',
  ),
);

expect.extend(matchers);

afterEach(cleanup);

Object.defineProperty(window, 'scrollTo', {
  configurable: true,
  value: vi.fn(),
  writable: true,
});
