/**
 * Constants Module
 *
 * This module provides shared constants for file extensions, patterns,
 * and other configuration values used throughout the utility modules.
 */

/**
 * Extension to language mapping
 * This is the single source of truth for supported file types and their languages
 * @type {Object.<string, string>}
 */
export const EXTENSION_TO_LANGUAGE_MAP = {
  // JavaScript and variants
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',

  // TypeScript and variants
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.d.ts': 'typescript',

  // Web technologies
  '.html': 'html',
  '.htm': 'html',
  '.css': 'css',
  '.scss': 'scss',
  '.sass': 'sass',
  '.less': 'less',
  '.svg': 'svg',

  // Configuration files
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.xml': 'xml',

  // Documentation
  '.md': 'markdown',
  '.mdx': 'markdown',
  '.markdown': 'markdown',
  '.rst': 'restructuredtext',
  '.adoc': 'asciidoc',
  '.txt': 'text',

  // Python
  '.py': 'python',
  '.pyi': 'python',
  '.ipynb': 'jupyter',

  // Ruby
  '.rb': 'ruby',
  '.erb': 'ruby',
  '.rake': 'ruby',

  // PHP
  '.php': 'php',
  '.phtml': 'php',

  // Java and JVM languages
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.groovy': 'groovy',
  '.scala': 'scala',

  // C-family languages
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.c++': 'cpp',
  '.h++': 'cpp',
  '.cs': 'csharp',

  // Go
  '.go': 'go',

  // Rust
  '.rs': 'rust',

  // Swift
  '.swift': 'swift',

  // Shell scripts
  '.sh': 'bash',
  '.bash': 'bash',
  '.zsh': 'zsh',
  '.fish': 'fish',

  // Other languages
  '.pl': 'perl',
  '.pm': 'perl',
  '.lua': 'lua',
  '.r': 'r',
  '.dart': 'dart',
  '.ex': 'elixir',
  '.exs': 'elixir',
  '.erl': 'erlang',
  '.hrl': 'erlang',
  '.clj': 'clojure',
  '.cljs': 'clojure',
  '.hs': 'haskell',
  '.lhs': 'haskell',

  // GraphQL
  '.graphql': 'graphql',
  '.gql': 'graphql',

  // Frameworks
  '.vue': 'vue',
  '.svelte': 'svelte',
  '.astro': 'astro',
  '.prisma': 'prisma',
};

/**
 * All supported file extensions derived from the language mapping
 * @type {string[]}
 */
export const ALL_SUPPORTED_EXTENSIONS = Object.keys(EXTENSION_TO_LANGUAGE_MAP);

/**
 * Documentation file extensions
 * @type {string[]}
 */
export const DOCUMENTATION_EXTENSIONS = ALL_SUPPORTED_EXTENSIONS.filter((ext) => {
  const lang = EXTENSION_TO_LANGUAGE_MAP[ext];
  return ['markdown', 'restructuredtext', 'asciidoc', 'text'].includes(lang);
});

/**
 * Code file extensions (excludes documentation types)
 * @type {string[]}
 */
export const CODE_EXTENSIONS = ALL_SUPPORTED_EXTENSIONS.filter((ext) => !DOCUMENTATION_EXTENSIONS.includes(ext));

/**
 * Binary file extensions that should be skipped during processing
 * @type {string[]}
 */
export const BINARY_EXTENSIONS = [
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.bmp',
  '.ico',
  '.webp',
  '.pdf',
  '.doc',
  '.docx',
  '.ppt',
  '.pptx',
  '.xls',
  '.xlsx',
  '.zip',
  '.tar',
  '.gz',
  '.7z',
  '.rar',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.ttf',
  '.otf',
  '.woff',
  '.woff2',
  '.mp3',
  '.mp4',
  '.avi',
  '.mov',
  '.wav',
];

/**
 * Directories to skip during file processing
 * @type {string[]}
 */
export const SKIP_DIRECTORIES = ['node_modules', 'dist', 'build', '.git', 'coverage', 'vendor'];

/**
 * File names to skip during processing (lock files, config files not useful as code examples)
 * @type {string[]}
 */
export const SKIP_FILENAMES = [
  // Lock files
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'composer.lock',
  'Gemfile.lock',
  // Package manifests (config, not source code)
  'package.json',
  'composer.json',
  'Gemfile',
  'Cargo.toml',
  'go.mod',
  'go.sum',
  'requirements.txt',
  'pyproject.toml',
  'pom.xml',
  'build.gradle',
  // Common config files (not useful as code examples)
  'tsconfig.json',
  'jsconfig.json',
  '.eslintrc',
  '.eslintrc.json',
  '.eslintrc.js',
  '.prettierrc',
  '.prettierrc.json',
  'prettier.config.js',
  '.babelrc',
  'babel.config.js',
  'jest.config.js',
  'jest.config.ts',
  'vitest.config.ts',
  'vitest.config.js',
  'webpack.config.js',
  'vite.config.js',
  'vite.config.ts',
  'rollup.config.js',
  '.dockerignore',
  '.gitignore',
  '.gitattributes',
  '.editorconfig',
  '.env.example',
  '.nvmrc',
  '.node-version',
];

/**
 * File patterns to skip during processing (likely generated files)
 * @type {RegExp[]}
 */
export const SKIP_FILE_PATTERNS = [
  /\.min\.(js|css)$/,
  /\.bundle\.(js|css)$/,
  /\.generated\./,
  /\.d\.ts$/,
  /\.snap$/,
  // Config file patterns
  /^\..*rc$/, // .eslintrc, .prettierrc, etc.
  /^\..*rc\.json$/, // .eslintrc.json, etc.
  /\.config\.(js|ts|mjs|cjs)$/, // *.config.js, *.config.ts files
];

/**
 * Regex pattern for detecting generic documentation files
 * Shared between different modules for consistency
 * @type {RegExp}
 */
export const GENERIC_DOC_REGEX = /(README|RUNBOOK|CONTRIBUTING|CHANGELOG|LICENSE|SETUP|INSTALL)(\.md|$)/i;
