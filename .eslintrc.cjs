module.exports = {
  env: {
    es2022: true,
    node: true,
  },
  extends: ['eslint:recommended'],
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
  plugins: ['sort-imports-es6-autofix'],
  rules: {
    'import/no-named-as-default': 'off',
    'no-unused-vars': ['warn', { vars: 'all', args: 'after-used', ignoreRestSiblings: true }],
    'sort-imports-es6-autofix/sort-imports-es6': [
      2,
      {
        ignoreCase: true,
        ignoreMemberSort: false,
        memberSyntaxSortOrder: ['none', 'all', 'multiple', 'single'],
      },
    ],
    'no-process-env': 0,
  },
  globals: {
    process: 'readable',
  },
  overrides: [
    {
      files: ['.eslintrc.{js,cjs}'],
      env: {
        node: true,
      },
      parserOptions: {
        sourceType: 'script',
      },
    },
    {
      files: ['*.test.tsx', '*.test.ts'],
      plugins: ['vitest'],
      extends: ['plugin:vitest/legacy-recommended'],
      rules: {
        'no-extend-native': 0,
        'require-atomic-updates': 0,
      },
    },
  ],
};
