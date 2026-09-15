import { afterEach, describe, expect, it, vi } from 'vitest';
import { saveMemoryFile } from './save-memory-file.js';
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe('User-requested memory downloads', () => {
  it('releases the ephemeral URL without writing browser storage', () => {
    vi.useFakeTimers();
    const create = vi.fn(() => 'blob:download'),
      revoke = vi.fn();
    vi.stubGlobal('URL', { createObjectURL: create, revokeObjectURL: revoke });
    const persist = vi.spyOn(Storage.prototype, 'setItem');
    const open = vi.fn(),
      cache = vi.fn();
    vi.stubGlobal('indexedDB', { open });
    vi.stubGlobal('caches', { open: cache });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {});
    saveMemoryFile(
      'original.xlsx',
      new Uint8Array([80, 75, 255]),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(create).toHaveBeenCalledWith(expect.any(Blob));
    expect(click).toHaveBeenCalledTimes(1);
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(revoke).toHaveBeenCalledWith('blob:download');
    expect(persist).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(cache).not.toHaveBeenCalled();
  });
  it('releases the URL immediately if initiating the download fails', () => {
    const revoke = vi.fn();
    vi.stubGlobal('URL', {
      createObjectURL: () => 'blob:failed',
      revokeObjectURL: revoke,
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() =>
      saveMemoryFile('original.csv', 'raw text', 'text/csv'),
    ).toThrow('blocked');
    expect(revoke).toHaveBeenCalledWith('blob:failed');
  });
});
