import js from '@eslint/js';
import vitest from '@vitest/eslint-plugin';
import importPlugin from 'eslint-plugin-import';
import globals from 'globals';

export default [
  // Base configuration for all files
  {
    files: ['**/*.js', '**/*.cjs', '**/*.mjs', '**/*.ts', '**/*.tsx'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.es2022,
        ...globals.node,
        process: 'readable',
      },
    },
    plugins: {
      import: importPlugin,
    },
    rules: {
      ...js.configs.recommended.rules,
      'import/no-named-as-default': 'off',
      'no-unused-vars': ['warn', { vars: 'all', args: 'after-used', ignoreRestSiblings: true }],
      'sort-imports': 'off',
      'import/order': [
        'warn',
        {
          groups: [
            'builtin', // Node.js built-in modules
            'external', // npm packages
            'internal', // Internal modules
            'parent', // Parent directories
            'sibling', // Same directory
            'index', // Index files
          ],
          'newlines-between': 'never',
          alphabetize: {
            order: 'asc',
            caseInsensitive: true,
          },
        },
      ],
      'no-process-env': 0,
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ImportExpression',
          message: 'Dynamic imports are not allowed. Use static imports instead.',
        },
      ],
    },
  },

  // Override for ESLint config files
  {
    files: ['eslint.config.js'],
    languageOptions: {
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
  },

  // Override for test files
  {
    files: ['**/*.test.js', '**/*.test.ts', '**/setupTests.js'],
    plugins: {
      vitest,
    },
    languageOptions: {
      globals: {
        ...vitest.environments.env.globals,
        // Custom test helpers defined in setupTests.js
        createMockEmbedding: 'readonly',
        createMockStats: 'readonly',
        mockConsole: 'readonly',
        mockConsoleSelective: 'readonly',
      },
    },
    rules: {
      ...vitest.configs.recommended.rules,
      'no-extend-native': 0,
      'require-atomic-updates': 0,
    },
  },

  // Ignore patterns
  {
    ignores: [
      '**/*.md',
      'docs/**',
      'dist/**',
      'build/**',
      '**/*.d.ts',
      '.prettierrc',
      '.editorconfig',
      '**/*.sh',
      'node_modules/**',
      '.git/**',
    ],
  },
];
