import { describe, expect, it } from 'vitest';
import { isIdentifierQuery, isIdentifierToken } from '../identifier-query';

describe('isIdentifierToken (SEARCH-54)', () => {
  it('accepts addresses, hashes and UUID fragments', () => {
    expect(isIdentifierToken('0xe3ec4cc359e68c9dce15bf667b1ad37df54a5a42')).toBe(true);
    expect(isIdentifierToken('0xBE8E3e')).toBe(true);
    expect(isIdentifierToken('a491d7d0')).toBe(true); // 8-hex uuid fragment
    expect(isIdentifierToken('771b1a445bb64c9b92dee45485c5a11f')).toBe(true);
  });

  it('rejects document numbers, words, and digits-only numbers', () => {
    expect(isIdentifierToken('a.1.2')).toBe(false); // doc numbers keep their machinery
    expect(isIdentifierToken('governance')).toBe(false);
    expect(isIdentifierToken('facade')).toBe(false); // hex-alphabet word, but only 6 chars
    expect(isIdentifierToken('deadbeef')).toBe(true); // 8 hex chars with letters IS an id
    expect(isIdentifierToken('12345678')).toBe(false); // digits-only: a number, not an id
    expect(isIdentifierToken('20260101')).toBe(false);
  });
});

describe('isIdentifierQuery (SEARCH-54)', () => {
  it('fires only when every content token is identifier-shaped', () => {
    expect(isIdentifierQuery(['0xe3ec4cc359e68c9dce15bf667b1ad37df54a5a42'])).toBe(true);
    expect(isIdentifierQuery(['a491d7d0', '0xbe8e3e12'])).toBe(true);
    expect(isIdentifierQuery(['0xbe8e3e12', 'vault'])).toBe(false); // mixed stays semantic
    expect(isIdentifierQuery(['a.1.2'])).toBe(false);
    expect(isIdentifierQuery([])).toBe(false);
  });
});
