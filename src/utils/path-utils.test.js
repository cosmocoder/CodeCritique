import { isPathWithinProject } from './path-utils.js';

describe('isPathWithinProject', () => {
  it('should accept a path inside the project', () => {
    expect(isPathWithinProject('/repo/src/file.js', '/repo')).toBe(true);
  });

  it('should accept the project root itself', () => {
    expect(isPathWithinProject('/repo', '/repo')).toBe(true);
  });

  it('should reject sibling project prefix collisions', () => {
    expect(isPathWithinProject('/repo-old/src/file.js', '/repo')).toBe(false);
  });

  it('should reject paths outside the project', () => {
    expect(isPathWithinProject('/other/file.js', '/repo')).toBe(false);
  });
});
