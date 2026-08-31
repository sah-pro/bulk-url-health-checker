import { describe, it, expect } from 'vitest';
import { normalizeUrl, parseUrlList } from '../url';

describe('normalizeUrl', () => {
  it('accepts a bare domain and defaults to https', () => {
    const result = normalizeUrl('example.com');
    expect(result.valid).toBe(true);
    expect(result.normalized).toBe('https://example.com');
  });

  it('lowercases the hostname and strips default ports', () => {
    const result = normalizeUrl('HTTPS://Example.com:443/Path');
    expect(result.valid).toBe(true);
    expect(result.normalized).toBe('https://example.com/Path');
  });

  it('rejects unsupported protocols', () => {
    const result = normalizeUrl('ftp://example.com');
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/unsupported protocol/);
  });

  it('rejects javascript: and other dangerous schemes', () => {
    const result = normalizeUrl('javascript:alert(1)');
    expect(result.valid).toBe(false);
  });

  it('rejects empty input', () => {
    const result = normalizeUrl('   ');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('empty');
  });

  it('rejects malformed URLs', () => {
    const result = normalizeUrl('http://');
    expect(result.valid).toBe(false);
  });
});

describe('parseUrlList', () => {
  it('splits on newlines and commas, ignores blank lines, dedupes', () => {
    const input = 'https://a.com\n\nhttps://b.com, https://a.com\nhttps://a.com/';
    const { valid, duplicates } = parseUrlList(input);
    // https://a.com and https://a.com/ normalize to the same value
    expect(valid.map((v) => v.normalized).sort()).toEqual(['https://a.com', 'https://b.com']);
    expect(duplicates.length).toBe(2);
  });

  it('separates invalid entries from valid ones', () => {
    const input = 'https://good.com\nnot a url\nftp://bad.com';
    const { valid, invalid } = parseUrlList(input);
    expect(valid).toHaveLength(1);
    expect(invalid).toHaveLength(2);
  });
});
