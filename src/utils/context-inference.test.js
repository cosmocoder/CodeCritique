import { openClassifier } from '../zero-shot-classifier-open.js';
import { inferContextFromCodeContent, inferContextFromDocumentContent } from './context-inference.js';

vi.mock('../zero-shot-classifier-open.js', () => ({
  openClassifier: {
    initialize: vi.fn(),
    classifyDocument: vi.fn(),
  },
}));

describe('inferContextFromCodeContent', () => {
  describe('JavaScript/TypeScript detection', () => {
    it('should detect React frontend', () => {
      const code = `
        import React, { useState, useEffect } from 'react';
        function App() { return <div>Hello</div>; }
      `;
      const result = inferContextFromCodeContent(code, 'javascript');

      expect(result.area).toBe('Frontend');
      expect(result.dominantTech).toContain('React');
    });

    it('should detect Angular frontend', () => {
      const code = `
        import { Component } from '@angular/core';
        @Component({ selector: 'app-root' })
        export class AppComponent {}
      `;
      const result = inferContextFromCodeContent(code, 'javascript');

      expect(result.area).toBe('Frontend');
      expect(result.dominantTech).toContain('Angular');
    });

    it('should detect Vue frontend', () => {
      const code = `
        import { createApp } from 'vue';
        createApp({ template: '<div>Hello Vue</div>' });
      `;
      const result = inferContextFromCodeContent(code, 'javascript');

      expect(result.area).toBe('Frontend');
      expect(result.dominantTech).toContain('Vue');
    });

    it('should detect Express backend', () => {
      const code = `
        const express = require('express');
        const app = express();
        app.listen(3000);
      `;
      const result = inferContextFromCodeContent(code, 'javascript');

      expect(result.area).toBe('Backend');
      expect(result.dominantTech).toContain('Node.js/Express');
    });

    it('should detect Node.js backend', () => {
      const code = `
        const http = require('http');
        http.createServer((req, res) => {
          res.end('Hello');
        });
      `;
      const result = inferContextFromCodeContent(code, 'javascript');

      expect(result.area).toBe('Backend');
      expect(result.dominantTech).toContain('Node.js');
    });

    it('should fallback to GeneralJS_TS for ambiguous code', () => {
      const code = `
        function add(a, b) { return a + b; }
        const result = add(1, 2);
      `;
      const result = inferContextFromCodeContent(code, 'javascript');

      expect(result.area).toBe('GeneralJS_TS');
    });
  });

  describe('Python detection', () => {
    it('should detect Django backend', () => {
      const code = `
        from django.shortcuts import render
        from django.http import HttpResponse
      `;
      const result = inferContextFromCodeContent(code, 'python');

      expect(result.area).toBe('Backend');
      expect(result.dominantTech).toContain('Django');
    });

    it('should detect Flask backend', () => {
      const code = `
        from flask import Flask, request
        app = Flask(__name__)
      `;
      const result = inferContextFromCodeContent(code, 'python');

      expect(result.area).toBe('Backend');
      expect(result.dominantTech).toContain('Flask');
    });

    it('should fallback to GeneralPython for generic code', () => {
      const code = `
        def greet(name):
            return f"Hello, {name}!"
      `;
      const result = inferContextFromCodeContent(code, 'python');

      expect(result.area).toBe('GeneralPython');
    });
  });

  describe('keyword extraction', () => {
    it('should extract common tech keywords', () => {
      const code = `
        import api from './api';
        class MyComponent extends Component {
          constructor(props) { super(props); }
        }
      `;
      const result = inferContextFromCodeContent(code, 'javascript');

      expect(result.keywords).toContain('api');
      expect(result.keywords).toContain('component');
      expect(result.keywords).toContain('class');
      expect(result.keywords).toContain('props');
    });

    it('should deduplicate keywords', () => {
      const code = 'component component component function function';
      const result = inferContextFromCodeContent(code, 'javascript');

      const componentCount = result.keywords.filter((k) => k === 'component').length;
      expect(componentCount).toBe(1);
    });
  });

  describe('unknown languages', () => {
    it('should return Unknown area for unsupported languages', () => {
      const code = 'some code content';
      const result = inferContextFromCodeContent(code, 'cobol');

      expect(result.area).toBe('Unknown');
    });
  });
});

describe('inferContextFromDocumentContent', () => {
  beforeEach(() => {
    mockConsoleSelective('error');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should use zero-shot classifier for document analysis', async () => {
    openClassifier.initialize.mockResolvedValue(undefined);
    openClassifier.classifyDocument.mockResolvedValue({
      technologies: [
        { technology: 'React', confidence: 0.9 },
        { technology: 'TypeScript', confidence: 0.7 },
      ],
      domains: [
        { domain: 'frontend/UI', confidence: 0.85 },
        { domain: 'API', confidence: 0.4 },
      ],
    });

    const result = await inferContextFromDocumentContent('/docs/guide.md', 'React Components', [
      { content: 'Using React hooks for state management', heading_text: 'Hooks' },
    ]);

    expect(openClassifier.initialize).toHaveBeenCalled();
    expect(openClassifier.classifyDocument).toHaveBeenCalled();
    expect(result.area).toBe('Frontend');
    expect(result.dominantTech).toContain('React');
  });

  it('should detect Backend area from domains', async () => {
    openClassifier.initialize.mockResolvedValue(undefined);
    openClassifier.classifyDocument.mockResolvedValue({
      technologies: [{ technology: 'Express', confidence: 0.8 }],
      domains: [{ domain: 'backend/server', confidence: 0.9 }],
    });

    const result = await inferContextFromDocumentContent('/docs/api.md', 'API Guide', []);

    expect(result.area).toBe('Backend');
  });

  it('should detect readme-style documents', async () => {
    openClassifier.initialize.mockResolvedValue(undefined);
    openClassifier.classifyDocument.mockResolvedValue({
      technologies: [],
      domains: [{ domain: 'getting started/setup', confidence: 0.8 }],
    });

    const result = await inferContextFromDocumentContent('README.md', 'Getting Started', [
      { content: 'Installation guide and setup instructions', heading_text: 'Installation' },
    ]);

    expect(result.isGeneralPurposeReadmeStyle).toBe(true);
  });

  it('should handle path-based hints for tooling', async () => {
    openClassifier.initialize.mockResolvedValue(undefined);
    openClassifier.classifyDocument.mockResolvedValue({
      technologies: [],
      domains: [{ domain: 'tooling', confidence: 0.6 }],
    });

    const result = await inferContextFromDocumentContent('/tools/cli-guide.md', 'CLI Tool', []);

    expect(result.area).toBe('ToolingInternal');
  });

  it('should fallback to keyword extraction on classifier error', async () => {
    openClassifier.initialize.mockRejectedValue(new Error('Model load failed'));

    const result = await inferContextFromDocumentContent('/docs/test.md', 'Test Document', [
      { content: 'This document contains specific technical terms like authentication and middleware' },
    ]);

    expect(result.area).toBe('Unknown');
    expect(result.keywords.length).toBeGreaterThan(0);
    expect(console.error).toHaveBeenCalled();
  });

  it('should return early for empty content', async () => {
    const result = await inferContextFromDocumentContent('', '', []);

    expect(result.area).toBe('UndeterminedByContent');
    expect(openClassifier.classifyDocument).not.toHaveBeenCalled();
  });

  it('should extract keywords from H1 and technologies', async () => {
    openClassifier.initialize.mockResolvedValue(undefined);
    openClassifier.classifyDocument.mockResolvedValue({
      technologies: [{ technology: 'GraphQL', confidence: 0.85 }],
      domains: [{ domain: 'API', confidence: 0.7 }],
    });

    const result = await inferContextFromDocumentContent('/docs/graphql-guide.md', 'GraphQL Integration', []);

    expect(result.keywords).toContain('graphql');
    expect(result.dominantTech).toContain('GraphQL');
  });
});
