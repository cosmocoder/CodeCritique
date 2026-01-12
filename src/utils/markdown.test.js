import { extractMarkdownChunks } from './markdown.js';

describe('extractMarkdownChunks', () => {
  beforeEach(() => {
    mockConsoleSelective('log', 'error');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('H1 extraction', () => {
    it('should extract H1 as document title', () => {
      const content = '# My Document Title\n\nSome content here.';
      const result = extractMarkdownChunks('/path/to/file.md', content, 'file.md');

      expect(result.documentH1).toBe('My Document Title');
    });

    it('should use filename as fallback when no H1 is present', () => {
      const content = 'Some content without any headings.';
      const result = extractMarkdownChunks('/path/to/myfile.md', content, 'myfile.md');

      expect(result.documentH1).toBe('myfile');
    });

    it('should only detect H1 in first 5 lines', () => {
      const content = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\n# Late H1\n\nContent';
      const result = extractMarkdownChunks('/path/to/file.md', content, 'file.md');

      // H1 on line 7 should not be detected as document title
      expect(result.documentH1).toBe('file');
    });
  });

  describe('chunk extraction by H2/H3 headings', () => {
    it('should split content by H2 headings', () => {
      const content = `# Document Title

## Section One

Content for section one.

## Section Two

Content for section two.
`;
      const result = extractMarkdownChunks('/path/to/file.md', content, 'file.md');

      // First chunk is content before any H2 (with null heading), then sections
      expect(result.chunks.length).toBe(3);
      expect(result.chunks[0].heading).toBeNull(); // Content before first H2
      expect(result.chunks[1].heading).toBe('Section One');
      expect(result.chunks[1].content).toContain('Content for section one');
      expect(result.chunks[2].heading).toBe('Section Two');
      expect(result.chunks[2].content).toContain('Content for section two');
    });

    it('should split content by H3 headings', () => {
      const content = `# Document Title

### Subsection A

Content A.

### Subsection B

Content B.
`;
      const result = extractMarkdownChunks('/path/to/file.md', content, 'file.md');

      // First chunk has null heading (H1 line), then subsections
      expect(result.chunks.length).toBe(3);
      expect(result.chunks[1].heading).toBe('Subsection A');
      expect(result.chunks[2].heading).toBe('Subsection B');
    });

    it('should handle mixed H2 and H3 headings', () => {
      const content = `# Title

## Main Section

Intro.

### Subsection

Details.
`;
      const result = extractMarkdownChunks('/path/to/file.md', content, 'file.md');

      // First chunk is H1 content, then Main Section, then Subsection
      expect(result.chunks.length).toBe(3);
      expect(result.chunks[1].heading).toBe('Main Section');
      expect(result.chunks[2].heading).toBe('Subsection');
    });
  });

  describe('code block handling', () => {
    it('should not split on headings inside code blocks', () => {
      const content = `# Title

## Real Section

\`\`\`markdown
## Fake Heading Inside Code Block
\`\`\`

More content.
`;
      const result = extractMarkdownChunks('/path/to/file.md', content, 'file.md');

      // Should have chunks - first is content before H2, second is Real Section
      expect(result.chunks.length).toBeGreaterThan(0);
      // Find the chunk with Real Section heading
      const realSectionChunk = result.chunks.find((c) => c.heading === 'Real Section');
      expect(realSectionChunk).toBeDefined();
      // The code block content should be in that chunk
      expect(realSectionChunk.content).toContain('Fake Heading Inside Code Block');
    });
  });

  describe('single chunk fallback', () => {
    it('should create single chunk when no H2/H3 headings exist', () => {
      const content = `# Document Title

This is just some content without any sub-headings.
Just paragraphs and text.
`;
      const result = extractMarkdownChunks('/path/to/file.md', content, 'file.md');

      expect(result.chunks.length).toBe(1);
      expect(result.chunks[0].heading).toBeNull();
      expect(result.chunks[0].content).toContain('just some content');
    });

    it('should include body content in single chunk', () => {
      const content = `# My Title
Some body content here.`;
      const result = extractMarkdownChunks('/path/to/file.md', content, 'file.md');

      expect(result.documentH1).toBe('My Title');
      expect(result.chunks.length).toBe(1);
      expect(result.chunks[0].content).toContain('Some body content');
    });
  });

  describe('chunk metadata', () => {
    it('should include correct metadata in chunks', () => {
      const content = `# Title

## Section

Content here.
`;
      const result = extractMarkdownChunks('/path/to/file.md', content, 'docs/file.md');

      expect(result.chunks[0].original_document_path).toBe('docs/file.md');
      expect(result.chunks[0].language).toBe('markdown');
      expect(result.chunks[0].start_line_in_doc).toBeGreaterThan(0);
    });
  });

  describe('edge cases', () => {
    it('should handle empty content', () => {
      const result = extractMarkdownChunks('/path/to/file.md', '', 'file.md');

      expect(result.chunks).toEqual([]);
      // Empty content returns null for documentH1
      expect(result.documentH1).toBeNull();
    });

    it('should handle null content', () => {
      const result = extractMarkdownChunks('/path/to/file.md', null, 'file.md');

      expect(result.chunks).toEqual([]);
      expect(result.documentH1).toBeNull();
    });

    it('should handle undefined content', () => {
      const result = extractMarkdownChunks('/path/to/file.md', undefined, 'file.md');

      expect(result.chunks).toEqual([]);
      expect(result.documentH1).toBeNull();
    });

    it('should handle sections with minimal content', () => {
      const content = `# Title

## Section One

Content.

## Section Two

More content.
`;
      const result = extractMarkdownChunks('/path/to/file.md', content, 'file.md');

      // Should extract all sections with content
      expect(result.chunks.length).toBeGreaterThan(0);
      const headings = result.chunks.map((c) => c.heading);
      expect(headings).toContain('Section One');
      expect(headings).toContain('Section Two');
    });

    it('should handle content before first H2', () => {
      const content = `# Title

Some intro content before any sections.

## First Section

Section content.
`;
      const result = extractMarkdownChunks('/path/to/file.md', content, 'file.md');

      // First chunk has null heading (content before H2), second has 'First Section'
      expect(result.chunks.length).toBe(2);
      expect(result.chunks[0].heading).toBeNull();
      expect(result.chunks[0].content).toContain('Some intro content');
      expect(result.chunks[1].heading).toBe('First Section');
    });
  });
});
