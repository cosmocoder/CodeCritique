import { slugify, addLineNumbers, escapeSqlString } from './string-utils.js';

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

describe('addLineNumbers', () => {
  describe('basic functionality', () => {
    it('should add line numbers to each line', () => {
      const input = 'const a = 1;\nconst b = 2;';
      const result = addLineNumbers(input);
      expect(result).toBe('1 | const a = 1;\n2 | const b = 2;');
    });

    it('should pad line numbers for files with 10+ lines', () => {
      const lines = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`);
      const input = lines.join('\n');
      const result = addLineNumbers(input);
      const outputLines = result.split('\n');
      // Single-digit lines should be padded with a leading space
      expect(outputLines[0]).toBe(' 1 | line 1');
      expect(outputLines[8]).toBe(' 9 | line 9');
      // Double-digit lines should not be padded
      expect(outputLines[9]).toBe('10 | line 10');
      expect(outputLines[11]).toBe('12 | line 12');
    });

    it('should pad line numbers for files with 100+ lines', () => {
      const lines = Array.from({ length: 105 }, (_, i) => `line ${i + 1}`);
      const input = lines.join('\n');
      const result = addLineNumbers(input);
      const outputLines = result.split('\n');
      expect(outputLines[0]).toBe('  1 | line 1');
      expect(outputLines[9]).toBe(' 10 | line 10');
      expect(outputLines[99]).toBe('100 | line 100');
    });

    it('should handle a single line', () => {
      expect(addLineNumbers('hello')).toBe('1 | hello');
    });

    it('should preserve empty lines', () => {
      const input = 'line1\n\nline3';
      const result = addLineNumbers(input);
      expect(result).toBe('1 | line1\n2 | \n3 | line3');
    });

    it('should preserve indentation', () => {
      const input = 'function foo() {\n  return 1;\n}';
      const result = addLineNumbers(input);
      expect(result).toBe('1 | function foo() {\n2 |   return 1;\n3 | }');
    });
  });

  describe('edge cases', () => {
    it('should return empty string for null input', () => {
      expect(addLineNumbers(null)).toBe('');
    });

    it('should return empty string for undefined input', () => {
      expect(addLineNumbers(undefined)).toBe('');
    });

    it('should return empty string for empty string input', () => {
      expect(addLineNumbers('')).toBe('');
    });

    it('should handle content with trailing newline', () => {
      const input = 'line1\nline2\n';
      const result = addLineNumbers(input);
      expect(result).toBe('1 | line1\n2 | line2\n3 | ');
    });
  });
});

describe('escapeSqlString', () => {
  it('should escape single quotes', () => {
    expect(escapeSqlString("it's fine")).toBe("it''s fine");
  });

  it('should coerce non-string values', () => {
    expect(escapeSqlString(42)).toBe('42');
  });

  it('should leave strings without single quotes unchanged', () => {
    expect(escapeSqlString('plain text')).toBe('plain text');
  });
});
