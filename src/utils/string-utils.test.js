import { slugify } from './string-utils.js';

describe('slugify', () => {
  describe('basic transformations', () => {
    it('should convert spaces to hyphens', () => {
      expect(slugify('Hello World')).toBe('hello-world');
    });

    it('should convert to lowercase', () => {
      expect(slugify('UPPERCASE')).toBe('uppercase');
      expect(slugify('MixedCase')).toBe('mixedcase');
    });

    it('should trim whitespace', () => {
      expect(slugify('  hello  ')).toBe('hello');
      expect(slugify('  hello world  ')).toBe('hello-world');
    });

    it('should handle multiple spaces', () => {
      expect(slugify('multiple   spaces')).toBe('multiple-spaces');
      expect(slugify('a    b    c')).toBe('a-b-c');
    });

    it('should remove special characters', () => {
      expect(slugify('hello!')).toBe('hello');
      expect(slugify('test@example')).toBe('testexample');
      expect(slugify('foo#bar$baz')).toBe('foobarbaz');
    });

    it('should replace multiple hyphens with single hyphen', () => {
      expect(slugify('hello--world')).toBe('hello-world');
      expect(slugify('a---b---c')).toBe('a-b-c');
    });
  });

  describe('edge cases', () => {
    it('should return empty string for null input', () => {
      expect(slugify(null)).toBe('');
    });

    it('should return empty string for undefined input', () => {
      expect(slugify(undefined)).toBe('');
    });

    it('should return empty string for empty string input', () => {
      expect(slugify('')).toBe('');
    });

    it('should handle numbers', () => {
      expect(slugify('version 2')).toBe('version-2');
      expect(slugify('123')).toBe('123');
    });

    it('should convert number to string', () => {
      expect(slugify(123)).toBe('123');
    });

    it('should handle strings with only special characters', () => {
      expect(slugify('!@#$%')).toBe('');
    });

    it('should handle strings with only whitespace', () => {
      expect(slugify('   ')).toBe('');
    });
  });

  describe('real-world use cases', () => {
    it('should slugify component names', () => {
      expect(slugify('My Component Name')).toBe('my-component-name');
      expect(slugify('UserProfileCard')).toBe('userprofilecard');
    });

    it('should slugify document titles', () => {
      expect(slugify('Engineering Guidelines')).toBe('engineering-guidelines');
      expect(slugify("What's New in v2.0")).toBe('whats-new-in-v20');
    });

    it('should preserve hyphens in input', () => {
      expect(slugify('pre-existing-slug')).toBe('pre-existing-slug');
    });

    it('should preserve underscores', () => {
      expect(slugify('with_underscore')).toBe('with_underscore');
    });
  });
});
