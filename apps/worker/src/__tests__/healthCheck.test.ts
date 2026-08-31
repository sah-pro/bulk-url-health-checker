import { describe, it, expect } from 'vitest';
import { classifyError } from '../healthCheck';

function errorWithCode(code: string): Error {
  const err = new Error(`simulated ${code}`);
  (err as unknown as { cause: { code: string } }).cause = { code };
  return err;
}

describe('classifyError', () => {
  it('treats an AbortError (timeout) as transient', () => {
    const err = new DOMException('The operation was aborted', 'AbortError');
    const result = classifyError(err, 8000);
    expect(result.transient).toBe(true);
  });

  it('treats ECONNRESET as transient', () => {
    const result = classifyError(errorWithCode('ECONNRESET'), 100);
    expect(result.transient).toBe(true);
  });

  it('treats ENOTFOUND (DNS failure) as transient', () => {
    const result = classifyError(errorWithCode('ENOTFOUND'), 50);
    expect(result.transient).toBe(true);
  });

  it('treats an unrecognized error as permanent', () => {
    const result = classifyError(new Error('totally unexpected'), 10);
    expect(result.transient).toBe(false);
  });
});
