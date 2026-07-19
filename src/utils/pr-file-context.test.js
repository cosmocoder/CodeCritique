import {
  buildFocusedFileContext,
  estimatePrContextTokens,
  formatPlannedHolisticFileContext,
  mergeHolisticFileContextPlans,
} from './pr-file-context.js';

it('estimates source code at 3.5 characters per token', () => {
  expect(estimatePrContextTokens('x'.repeat(35))).toBe(10);
});

describe('mergeHolisticFileContextPlans', () => {
  it('keeps complete file content when the PR fits the holistic context budget', () => {
    const plans = mergeHolisticFileContextPlans([
      { filePath: 'src/a.js', content: 'const a = 1;', diffContent: '+const a = 1;' },
      { filePath: 'src/b.js', content: 'const b = 2;', diffContent: '+const b = 2;' },
    ]);

    expect(plans.map((plan) => plan.mode)).toEqual(['full', 'full']);
  });

  it('uses focused context for files that exceed the total full-content budget', () => {
    const plans = mergeHolisticFileContextPlans([
      { filePath: 'src/huge.js', content: 'x'.repeat(210000), diffContent: '+changed' },
      { filePath: 'src/small.js', content: 'const ok = true;', diffContent: '+const ok = true;' },
    ]);

    expect(plans[0].mode).toBe('focused');
    expect(plans[1].mode).toBe('full');
  });

  it('keeps a file above the per-file soft cap complete when total budget allows', () => {
    const plans = mergeHolisticFileContextPlans([{ filePath: 'src/large.js', content: 'x'.repeat(45000), diffContent: '+changed' }]);

    expect(plans[0].mode).toBe('full');
  });

  it('does not let one huge file consume almost the entire full-content budget', () => {
    const plans = mergeHolisticFileContextPlans([
      { filePath: 'src/huge.js', content: 'x'.repeat(174000), diffContent: '+important change'.repeat(50) },
      { filePath: 'src/small.js', content: 'const ok = true;', diffContent: '+const ok = true;' },
    ]);

    expect(plans[0].mode).toBe('focused');
    expect(plans[0].reason).toContain('per-file holistic context ceiling');
    expect(plans[1].mode).toBe('full');
  });

  it('prioritizes larger changed files over trivial small files when the aggregate budget is tight', () => {
    const plans = mergeHolisticFileContextPlans(
      [
        { filePath: 'src/large.js', content: 'a'.repeat(45), diffContent: '+important change'.repeat(10) },
        { filePath: 'src/small-1.js', content: 'b'.repeat(15), diffContent: '+b' },
        { filePath: 'src/small-2.js', content: 'c'.repeat(15), diffContent: '+c' },
      ],
      { maxSingleFullContentTokens: 100, maxTotalFullContentTokens: 20 }
    );

    expect(plans[0].mode).toBe('full');
  });

  it('reserves already allocated full-content budget when filling missing plans', () => {
    const plans = mergeHolisticFileContextPlans(
      [
        { filePath: 'src/already-planned.js', content: 'a'.repeat(120), diffContent: '+a' },
        { filePath: 'src/missing-large.js', content: 'b'.repeat(120), diffContent: '+b' },
        { filePath: 'src/missing-small.js', content: 'c'.repeat(15), diffContent: '+c' },
      ],
      { maxTotalFullContentTokens: 50, maxSingleFullContentTokens: 50 },
      [{ mode: 'full', fullContentTokens: 40, contextTokens: 40, totalTokens: 41 }]
    );

    expect(plans[0].mode).toBe('full');
    expect(plans[1].mode).toBe('focused');
    expect(plans[2].mode).toBe('full');
  });
});

describe('formatPlannedHolisticFileContext', () => {
  it('formats complete file context with line numbers', () => {
    const file = { language: 'javascript', content: 'const a = 1;\nconst b = 2;' };
    const rendered = formatPlannedHolisticFileContext(file, { mode: 'full' });

    expect(rendered).toContain('Full File Content');
    expect(rendered).toContain('const a = 1;');
    expect(rendered).toContain('const b = 2;');
  });

  it('formats focused context around changed hunks', () => {
    const content = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join('\n');
    const file = {
      language: 'javascript',
      content,
      diffContent: '@@ -10,1 +10,1 @@\n-line 10\n+line 10 changed',
    };
    const rendered = buildFocusedFileContext(
      file,
      { mode: 'focused', reason: 'test budget', fullContentTokens: 100, contextTokens: 10, totalTokens: 20 },
      { contextLineRadius: 2 }
    );

    expect(rendered).toContain('Focused File Context');
    expect(rendered).toContain('lines 8-12');
    expect(rendered).toContain('10 | line 10');
    expect(rendered).not.toContain('20 | line 20');
  });

  it('anchors added lines whose content starts with ++', () => {
    const content = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join('\n');
    const rendered = buildFocusedFileContext(
      {
        language: 'javascript',
        content,
        diffContent: '@@ -10,0 +10,2 @@\n+++counter;\n+line 10 changed',
      },
      { mode: 'focused', reason: 'test budget' },
      { contextLineRadius: 0 }
    );

    expect(rendered).toContain('lines 10-11');
    expect(rendered).toContain('10 | line 10');
    expect(rendered).toContain('11 | line 11');
  });

  it('anchors deletion-only hunks near the deleted region', () => {
    const content = Array.from({ length: 200 }, (_, index) => `line ${index + 1}`).join('\n');
    const rendered = buildFocusedFileContext(
      {
        language: 'javascript',
        content,
        diffContent: '@@ -150,2 +150,0 @@\n-line 150\n-line 151',
      },
      { mode: 'focused', reason: 'test budget' },
      { contextLineRadius: 2 }
    );

    expect(rendered).toContain('lines 148-152');
    expect(rendered).toContain('150 | line 150');
    expect(rendered).not.toMatch(/\n\s*1 \| line 1\n/);
  });

  it('clamps deletion-only anchors that point beyond the available file content', () => {
    const content = Array.from({ length: 7 }, (_, index) => `line ${index + 1}`).join('\n');
    const rendered = buildFocusedFileContext(
      {
        language: 'javascript',
        content,
        diffContent: '@@ -50,5 +50,0 @@\n-line 50\n-line 51',
      },
      { mode: 'focused', reason: 'test budget' },
      { contextLineRadius: 40 }
    );

    expect(rendered).toContain('lines 1-7');
    expect(rendered).toContain('7 | line 7');
    expect(rendered).not.toContain('lines 10-7');
    expect(rendered).not.toContain('Included -');
  });

  it('renders focused context from the current file instead of a cached plan copy', () => {
    const plan = { mode: 'focused', reason: 'test budget' };
    const file = {
      language: 'javascript',
      content: 'line 1\nline 2',
      diffContent: '@@ -2,1 +2,1 @@\n-line 2\n+line 2 changed',
    };

    buildFocusedFileContext(file, plan);
    const secondRender = buildFocusedFileContext({ ...file, content: 'different 1\ndifferent 2' }, plan);

    expect(secondRender).toContain('different 2');
    expect(secondRender).not.toContain('line 2');
  });

  it('shrinks a focused window to fit the remaining context budget instead of dropping it', () => {
    const content = Array.from({ length: 200 }, (_, index) => `line ${index + 1} ${'x'.repeat(35)}`).join('\n');
    const rendered = buildFocusedFileContext(
      {
        language: 'javascript',
        content,
        diffContent: '@@ -100,1 +100,1 @@\n-line 100\n+line 100 changed',
      },
      { mode: 'focused', reason: 'chunk budget', maxFocusedContextTokens: 500 },
      { contextLineRadius: 40 }
    );

    expect(rendered).toContain('100 | line 100');
    expect(rendered).not.toContain('No focused file context windows fit');
    expect(rendered).not.toContain('lines 60-140');
  });

  it('keeps minimal context for distant change sites when budget is tight', () => {
    const content = Array.from({ length: 2000 }, (_, index) => `line ${index + 1} ${'x'.repeat(20)}`).join('\n');
    const rendered = buildFocusedFileContext(
      {
        language: 'javascript',
        content,
        diffContent: '@@ -10,1 +10,1 @@\n-line 10\n+line 10 changed\n@@ -1990,1 +1990,1 @@\n-line 1990\n+line 1990 changed',
      },
      { mode: 'focused', reason: 'chunk budget', maxFocusedContextTokens: 700 },
      { contextLineRadius: 40 }
    );

    expect(rendered).toContain('10 | line 10');
    expect(rendered).toContain('1990 | line 1990');
    expect(rendered).not.toContain('No focused file context windows fit');
  });

  it('validates selected focused windows against the actual rendered markdown budget', () => {
    const content = Array.from({ length: 1200 }, (_, index) => `line ${index + 1}`).join('\n');
    const diffContent = Array.from(
      { length: 1200 },
      (_, index) => `@@ -${index + 1},1 +${index + 1},1 @@\n-line ${index + 1}\n+line ${index + 1} changed`
    ).join('\n');
    const rendered = buildFocusedFileContext(
      {
        language: 'javascript',
        content,
        diffContent,
      },
      { mode: 'focused', reason: 'chunk budget', maxFocusedContextTokens: 9500 },
      { contextLineRadius: 0 }
    );

    expect(estimatePrContextTokens(rendered)).toBeLessThanOrEqual(9500);
  });

  it('keeps anchorless fallback context within the focused context budget', () => {
    const content = Array.from({ length: 200 }, (_, index) => `line ${index + 1} ${'x'.repeat(30)}`).join('\n');
    const rendered = buildFocusedFileContext(
      {
        language: 'javascript',
        content,
        diffContent: 'mode change only',
      },
      { mode: 'focused', reason: 'chunk budget', maxFocusedContextTokens: 0 },
      { contextLineRadius: 40 }
    );

    expect(rendered).toContain('No focused file context windows fit');
    expect(rendered).not.toContain('1 | line 1');
  });
});
