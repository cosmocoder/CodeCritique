import { isGenericDocument, getGenericDocumentContext } from './document-detection.js';

describe('isGenericDocument', () => {
  describe('filename-based detection', () => {
    it('should return true for README files', () => {
      expect(isGenericDocument('README.md')).toBe(true);
      expect(isGenericDocument('readme.md')).toBe(true);
      expect(isGenericDocument('docs/README.md')).toBe(true);
    });

    it('should return true for RUNBOOK files', () => {
      expect(isGenericDocument('RUNBOOK.md')).toBe(true);
      expect(isGenericDocument('runbook.md')).toBe(true);
    });

    it('should return true for CHANGELOG files', () => {
      expect(isGenericDocument('CHANGELOG.md')).toBe(true);
      expect(isGenericDocument('changelog.md')).toBe(true);
    });

    it('should return true for CONTRIBUTING files', () => {
      expect(isGenericDocument('CONTRIBUTING.md')).toBe(true);
      expect(isGenericDocument('contributing.md')).toBe(true);
    });

    it('should return true for LICENSE files', () => {
      expect(isGenericDocument('LICENSE.md')).toBe(true);
      expect(isGenericDocument('LICENSE')).toBe(true);
    });

    it('should return false for regular documentation files', () => {
      expect(isGenericDocument('docs/api-guide.md')).toBe(false);
      expect(isGenericDocument('docs/architecture.md')).toBe(false);
    });
  });

  describe('H1 title-based detection', () => {
    it('should return true when H1 contains readme-style keywords', () => {
      expect(isGenericDocument('some-file.md', 'README for Project')).toBe(true);
      expect(isGenericDocument('guide.md', 'Getting Started')).toBe(true);
      expect(isGenericDocument('guide.md', 'Installation Guide')).toBe(true);
      expect(isGenericDocument('guide.md', 'Setup Instructions')).toBe(true);
    });

    it('should return false when H1 does not contain generic keywords', () => {
      expect(isGenericDocument('api.md', 'API Reference')).toBe(false);
      expect(isGenericDocument('auth.md', 'Authentication Flow')).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should return false for null/undefined docPath', () => {
      expect(isGenericDocument(null)).toBe(false);
      expect(isGenericDocument(undefined)).toBe(false);
      expect(isGenericDocument('')).toBe(false);
    });

    it('should handle case insensitivity', () => {
      expect(isGenericDocument('README.MD')).toBe(true);
      expect(isGenericDocument('Readme.md')).toBe(true);
    });
  });
});

describe('getGenericDocumentContext', () => {
  it('should return correct context for README files', () => {
    const context = getGenericDocumentContext('README.md');

    expect(context.area).toBe('Documentation');
    expect(context.dominantTech).toContain('markdown');
    expect(context.dominantTech).toContain('documentation');
    expect(context.isGeneralPurposeReadmeStyle).toBe(true);
    expect(context.fastPath).toBe(true);
    expect(context.docPath).toBe('README.md');
  });

  it('should return correct context for RUNBOOK files', () => {
    const context = getGenericDocumentContext('runbook.md');

    expect(context.area).toBe('Operations');
    expect(context.dominantTech).toContain('operations');
    expect(context.dominantTech).toContain('devops');
  });

  it('should return correct context for CHANGELOG files', () => {
    const context = getGenericDocumentContext('CHANGELOG.md');

    expect(context.area).toBe('Documentation');
    expect(context.dominantTech).toContain('versioning');
    expect(context.dominantTech).toContain('releases');
  });

  it('should return correct context for CONTRIBUTING files', () => {
    const context = getGenericDocumentContext('CONTRIBUTING.md');

    expect(context.area).toBe('Development');
    expect(context.dominantTech).toContain('git');
    expect(context.dominantTech).toContain('contribution');
  });

  it('should return correct context for LICENSE files', () => {
    const context = getGenericDocumentContext('LICENSE.md');

    expect(context.area).toBe('Legal');
    expect(context.dominantTech).toContain('licensing');
  });

  it('should return correct context for setup/install files', () => {
    const setupContext = getGenericDocumentContext('setup-guide.md');
    expect(setupContext.area).toBe('Setup');
    expect(setupContext.dominantTech).toContain('installation');

    const installContext = getGenericDocumentContext('install.md');
    expect(installContext.area).toBe('Setup');
    expect(installContext.dominantTech).toContain('configuration');
  });

  it('should return base context for unknown generic files', () => {
    const context = getGenericDocumentContext('some-file.md');

    expect(context.area).toBe('General');
    expect(context.dominantTech).toEqual([]);
    expect(context.isGeneralPurposeReadmeStyle).toBe(true);
    expect(context.fastPath).toBe(true);
  });
});
