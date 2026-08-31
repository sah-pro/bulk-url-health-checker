import { describe, it, expect } from 'vitest';
import { extractUrlColumn } from '../routes/batches';

describe('extractUrlColumn', () => {
  it('uses a column named "url" case-insensitively when present', () => {
    const records = [
      { Name: 'Example', URL: 'https://example.com' },
      { Name: 'Other', URL: 'https://other.com' },
    ];
    expect(extractUrlColumn(records)).toEqual(['https://example.com', 'https://other.com']);
  });

  it('falls back to the first column when no "url" column exists', () => {
    const records = [{ site: 'https://example.com' }, { site: 'https://other.com' }];
    expect(extractUrlColumn(records)).toEqual(['https://example.com', 'https://other.com']);
  });

  it('drops empty cells', () => {
    const records = [{ url: 'https://example.com' }, { url: '' }];
    expect(extractUrlColumn(records)).toEqual(['https://example.com']);
  });

  it('returns an empty array for an empty CSV', () => {
    expect(extractUrlColumn([])).toEqual([]);
  });
});
