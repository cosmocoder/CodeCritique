import { detectLanguageFromExtension, detectFileType } from './language-detection.js';

describe('detectLanguageFromExtension', () => {
  describe('JavaScript/TypeScript extensions', () => {
    it('should detect JavaScript from .js extension', () => {
      expect(detectLanguageFromExtension('.js')).toBe('javascript');
    });

    it('should detect TypeScript from .ts extension', () => {
      expect(detectLanguageFromExtension('.ts')).toBe('typescript');
    });

    it('should detect JavaScript from .jsx extension', () => {
      expect(detectLanguageFromExtension('.jsx')).toBe('javascript');
    });

    it('should detect TypeScript from .tsx extension', () => {
      expect(detectLanguageFromExtension('.tsx')).toBe('typescript');
    });

    it('should detect JavaScript from .mjs extension', () => {
      expect(detectLanguageFromExtension('.mjs')).toBe('javascript');
    });

    it('should detect JavaScript from .cjs extension', () => {
      expect(detectLanguageFromExtension('.cjs')).toBe('javascript');
    });
  });

  describe('other languages', () => {
    it('should detect Python from .py extension', () => {
      expect(detectLanguageFromExtension('.py')).toBe('python');
    });

    it('should detect Ruby from .rb extension', () => {
      expect(detectLanguageFromExtension('.rb')).toBe('ruby');
    });

    it('should detect Java from .java extension', () => {
      expect(detectLanguageFromExtension('.java')).toBe('java');
    });

    it('should detect Go from .go extension', () => {
      expect(detectLanguageFromExtension('.go')).toBe('go');
    });

    it('should detect Rust from .rs extension', () => {
      expect(detectLanguageFromExtension('.rs')).toBe('rust');
    });
  });

  describe('config and data formats', () => {
    it('should detect JSON from .json extension', () => {
      expect(detectLanguageFromExtension('.json')).toBe('json');
    });

    it('should detect YAML from .yml extension', () => {
      expect(detectLanguageFromExtension('.yml')).toBe('yaml');
    });

    it('should detect YAML from .yaml extension', () => {
      expect(detectLanguageFromExtension('.yaml')).toBe('yaml');
    });

    it('should detect Markdown from .md extension', () => {
      expect(detectLanguageFromExtension('.md')).toBe('markdown');
    });
  });

  describe('extension normalization', () => {
    it('should handle uppercase extensions', () => {
      expect(detectLanguageFromExtension('.JS')).toBe('javascript');
      expect(detectLanguageFromExtension('.TS')).toBe('typescript');
    });

    it('should handle extensions without leading dot', () => {
      expect(detectLanguageFromExtension('js')).toBe('javascript');
      expect(detectLanguageFromExtension('py')).toBe('python');
    });

    it('should handle mixed case extensions', () => {
      expect(detectLanguageFromExtension('.Js')).toBe('javascript');
    });
  });

  describe('unknown extensions', () => {
    it('should return unknown for unsupported extensions', () => {
      expect(detectLanguageFromExtension('.xyz')).toBe('unknown');
      expect(detectLanguageFromExtension('.unknown')).toBe('unknown');
    });
  });
});

describe('detectFileType', () => {
  describe('basic file type detection', () => {
    it('should detect language from file extension', () => {
      const result = detectFileType('src/utils.js');
      expect(result.language).toBe('javascript');
      expect(result.extension).toBe('.js');
    });

    it('should include file path in result', () => {
      const result = detectFileType('/path/to/file.ts');
      expect(result.path).toBe('/path/to/file.ts');
    });
  });

  describe('test file detection', () => {
    it('should detect .test.js files as test', () => {
      const result = detectFileType('component.test.js');
      expect(result.isTest).toBe(true);
      expect(result.type).toBe('test');
    });

    it('should detect .spec.ts files as test', () => {
      const result = detectFileType('service.spec.ts');
      expect(result.isTest).toBe(true);
      expect(result.type).toBe('test');
    });

    it('should detect _test.py files as test', () => {
      const result = detectFileType('utils_test.py');
      expect(result.isTest).toBe(true);
    });

    it('should detect _spec.rb files as test', () => {
      const result = detectFileType('model_spec.rb');
      expect(result.isTest).toBe(true);
    });

    it('should detect test_*.py files as test', () => {
      const result = detectFileType('test_utils.py');
      expect(result.isTest).toBe(true);
    });
  });

  describe('config file detection', () => {
    it('should detect config files', () => {
      const result = detectFileType('webpack.config.js');
      expect(result.isConfig).toBe(true);
      expect(result.type).toBe('config');
    });

    it('should detect .rc files as config', () => {
      // .eslintrc pattern matches config via the 'rc' suffix check in the regex
      // Note: The regex matches 'config|conf|settings|.rc$', so files ending with literal '.rc' match
      const result = detectFileType('lint.rc');
      expect(result.isConfig).toBe(true);
    });

    it('should detect settings files as config', () => {
      const result = detectFileType('settings.json');
      expect(result.isConfig).toBe(true);
    });
  });

  describe('type definition detection', () => {
    it('should detect .d.ts files as type definitions', () => {
      const result = detectFileType('types.d.ts');
      expect(result.isTypeDefinition).toBe(true);
      expect(result.type).toBe('type-definition');
    });
  });

  describe('framework detection with content', () => {
    it('should detect React from JSX extension', () => {
      // Framework detection requires non-empty content
      const result = detectFileType('Component.jsx', 'export default function App() {}');
      expect(result.framework).toBe('react');
    });

    it('should detect React from TSX extension', () => {
      // Framework detection requires non-empty content
      const result = detectFileType('Component.tsx', 'export default function App() {}');
      expect(result.framework).toBe('react');
    });

    it('should detect React from import statement', () => {
      const content = "import React from 'react';\nexport const App = () => <div>Hello</div>;";
      const result = detectFileType('App.js', content);
      expect(result.framework).toBe('react');
    });

    it('should detect Vue from .vue extension', () => {
      // Framework detection requires non-empty content
      const result = detectFileType('Component.vue', '<template></template>');
      expect(result.framework).toBe('vue');
    });

    it('should detect Vue from template/script tags', () => {
      const content = '<template><div>Hello</div></template><script>export default {}</script>';
      const result = detectFileType('Component.js', content);
      expect(result.framework).toBe('vue');
    });

    it('should detect Angular from decorators', () => {
      const content = "@Component({ selector: 'app-root' }) export class AppComponent {}";
      const result = detectFileType('app.component.ts', content);
      expect(result.framework).toBe('angular');
    });

    it('should detect Express from require statement', () => {
      const content = "const express = require('express'); const app = express();";
      const result = detectFileType('server.js', content);
      expect(result.framework).toBe('express');
    });

    it('should detect Next.js from imports', () => {
      // The function detects Next.js from 'from "next"', 'next/app', or 'next/document' imports
      const content = "import Head from 'next/app';\nexport default function Page() {}";
      const result = detectFileType('page.js', content);
      expect(result.framework).toBe('nextjs');
    });

    it('should detect Django from imports', () => {
      const content = 'from django.http import HttpResponse';
      const result = detectFileType('views.py', content);
      expect(result.framework).toBe('django');
    });

    it('should detect Flask from imports', () => {
      const content = 'from flask import Flask\napp = Flask(__name__)';
      const result = detectFileType('app.py', content);
      expect(result.framework).toBe('flask');
    });

    it('should detect Rails from ActiveRecord', () => {
      const content = 'class User < ActiveRecord::Base\nend';
      const result = detectFileType('user.rb', content);
      expect(result.framework).toBe('rails');
    });

    it('should detect Spring from annotations', () => {
      const content = '@SpringBootApplication\npublic class Application {}';
      const result = detectFileType('Application.java', content);
      expect(result.framework).toBe('spring');
    });
  });

  describe('React component detection', () => {
    it('should detect function components', () => {
      const content = `
        import React from 'react';
        function MyComponent() {
          const [state, setState] = useState(0);
          return <div>{state}</div>;
        }
      `;
      const result = detectFileType('MyComponent.jsx', content);
      expect(result.framework).toBe('react');
      expect(result.isComponent).toBe(true);
    });

    it('should detect hooks', () => {
      const content = `
        import { useState, useEffect } from 'react';
        function useCustomHook() {
          const [value, setValue] = useState(null);
          useEffect(() => {}, []);
          return value;
        }
      `;
      const result = detectFileType('useCustomHook.js', content);
      expect(result.framework).toBe('react');
      expect(result.isHook).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('should handle files without content', () => {
      const result = detectFileType('file.js');
      expect(result.language).toBe('javascript');
      expect(result.framework).toBeNull();
    });

    it('should handle empty content string', () => {
      const result = detectFileType('file.ts', '');
      expect(result.language).toBe('typescript');
    });

    it('should handle unknown extensions', () => {
      const result = detectFileType('file.unknown');
      expect(result.language).toBe('unknown');
      expect(result.type).toBe('unknown');
    });
  });
});
