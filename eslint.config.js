import js from '@eslint/js';
import globals from 'globals';
import vitest from '@vitest/eslint-plugin';

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
    plugins: {},
    rules: {
      ...js.configs.recommended.rules,
      'import/no-named-as-default': 'off',
      'no-unused-vars': ['warn', { vars: 'all', args: 'after-used', ignoreRestSiblings: true }],
      'sort-imports': [
        'error',
        {
          ignoreCase: true,
          ignoreMemberSort: false,
          memberSyntaxSortOrder: ['none', 'all', 'multiple', 'single'],
          ignoreDeclarationSort: false,
          allowSeparatedGroups: false,
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
    files: ['**/*.test.tsx', '**/*.test.ts'],
    plugins: {
      vitest,
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
