/**
 * Utility Functions Module
 *
 * This module provides utility functions for language/framework detection
 * and file type analysis. These functions are used throughout the code review
 * tool to make it technology-agnostic and configurable.
 */

import { execSync } from 'child_process';
import { minimatch } from 'minimatch';
import fs from 'fs';
import path from 'path';

// --- Constants for File Extensions ---
const DOCUMENTATION_EXTENSIONS = ['.md', '.mdx', '.markdown', '.rst', '.adoc', '.txt'];

// Define all supported extensions explicitly - This becomes the source of truth
const ALL_SUPPORTED_EXTENSIONS = [
  // JavaScript and variants
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',

  // TypeScript and variants
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.d.ts',

  // Web technologies
  '.html',
  '.htm',
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.svg',

  // Configuration files
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.xml',

  // Documentation (defined above)
  ...DOCUMENTATION_EXTENSIONS,

  // Python
  '.py',
  '.pyi',
  '.ipynb',

  // Ruby
  '.rb',
  '.erb',
  '.rake',

  // PHP
  '.php',
  '.phtml',

  // Java and JVM languages
  '.java',
  '.kt',
  '.kts',
  '.groovy',
  '.scala',

  // C-family languages
  '.c',
  '.h',
  '.cpp',
  '.cc',
  '.cxx',
  '.hpp',
  '.c++',
  '.h++',
  '.cs',

  // Go
  '.go',

  // Rust
  '.rs',

  // Swift
  '.swift',

  // Shell scripts
  '.sh',
  '.bash',
  '.zsh',
  '.fish',

  // Other languages
  '.pl',
  '.pm',
  '.lua',
  '.r',
  '.dart',
  '.ex',
  '.exs',
  '.erl',
  '.hrl',
  '.clj',
  '.cljs',
  '.hs',
  '.lhs',

  // GraphQL
  '.graphql',
  '.gql',

  // Frameworks
  '.vue',
  '.svelte',
  '.astro',
  '.prisma',
];

// Derive CODE_EXTENSIONS by filtering ALL_SUPPORTED_EXTENSIONS
// Exclude documentation types. Consider excluding config types if needed.
const CODE_EXTENSIONS = [...new Set(ALL_SUPPORTED_EXTENSIONS)].filter((ext) => !DOCUMENTATION_EXTENSIONS.includes(ext));

// --- End Constants ---

/**
 * Detect programming language from file extension
 *
 * @param {string} extension - File extension (including the dot)
 * @returns {string|null} Detected language or null if unknown
 */
function detectLanguageFromExtension(extension) {
  // Normalize extension to lowercase with leading dot
  const normalizedExt = extension.toLowerCase();
  if (!normalizedExt.startsWith('.')) {
    extension = `.${normalizedExt}`;
  } else {
    extension = normalizedExt;
  }

  // Map of file extensions to languages
  const extensionMap = {
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
    '.rst': 'restructuredtext',

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
  };

  // Return the detected language or 'unknown' as a fallback
  return extensionMap[extension] || 'unknown';
}

/**
 * Detect file type and framework from file path and content
 *
 * @param {string} filePath - Path to the file
 * @param {string} content - Content of the file (optional)
 * @returns {Object} File type information
 */
function detectFileType(filePath, content = '') {
  // Get file extension and base name
  const extension = path.extname(filePath);
  const baseName = path.basename(filePath);

  // Detect language from extension
  const language = detectLanguageFromExtension(extension);

  // Initialize result object
  const result = {
    path: filePath,
    extension,
    language,
    type: 'unknown',
    framework: null,
    isConfig: false,
    isTest: false,
    isTypeDefinition: false,
  };

  // Detect file type based on name patterns
  if (baseName.endsWith('.d.ts')) {
    result.type = 'type-definition';
    result.isTypeDefinition = true;
  } else if (baseName.match(/\.test\.|\.spec\.|_test\.|_spec\./)) {
    result.type = 'test';
    result.isTest = true;
  } else if (baseName.match(/^test.*\.|^spec.*\./)) {
    result.type = 'test';
    result.isTest = true;
  } else if (baseName.match(/config|conf|settings|\.rc$/)) {
    result.type = 'config';
    result.isConfig = true;
  } else if (language) {
    result.type = language;
  }

  // If content is provided, perform deeper analysis
  if (content && content.length > 0) {
    // Detect React
    if (
      extension === '.jsx' ||
      extension === '.tsx' ||
      content.includes('import React') ||
      content.includes('from "react"') ||
      content.includes("from 'react'")
    ) {
      result.framework = 'react';

      // Check for specific React patterns
      if (content.includes('useState') || content.includes('useEffect') || content.includes('useContext')) {
        result.isHook = content.match(/^\s*function\s+use[A-Z]/m) !== null;
        result.isComponent = content.match(/^\s*function\s+[A-Z]/m) !== null || content.match(/^\s*const\s+[A-Z]\w+\s*=\s*\(/m) !== null;
      }
    }

    // Detect Vue
    else if (extension === '.vue' || (content.includes('<template>') && content.includes('<script>'))) {
      result.framework = 'vue';
    }

    // Detect Angular
    else if (
      content.includes('@Component') ||
      content.includes('@NgModule') ||
      content.includes('from "@angular/core"') ||
      content.includes("from '@angular/core'")
    ) {
      result.framework = 'angular';
    }

    // Detect Express.js
    else if (
      content.includes('express()') ||
      content.includes('require("express")') ||
      content.includes("require('express')") ||
      content.includes('from "express"') ||
      content.includes("from 'express'")
    ) {
      result.framework = 'express';
    }

    // Detect Next.js
    else if (
      content.includes('from "next"') ||
      content.includes("from 'next'") ||
      content.includes('next/app') ||
      content.includes('next/document')
    ) {
      result.framework = 'nextjs';
    }

    // Detect Django (Python)
    else if (language === 'python' && (content.includes('from django') || content.includes('import django'))) {
      result.framework = 'django';
    }

    // Detect Flask (Python)
    else if (language === 'python' && (content.includes('from flask import') || content.includes('import flask'))) {
      result.framework = 'flask';
    }

    // Detect Rails (Ruby)
    else if (language === 'ruby' && (content.includes('Rails') || content.includes('ActiveRecord'))) {
      result.framework = 'rails';
    }

    // Detect Spring (Java)
    else if (
      language === 'java' &&
      (content.includes('@Controller') ||
        content.includes('@Service') ||
        content.includes('@Repository') ||
        content.includes('@SpringBootApplication'))
    ) {
      result.framework = 'spring';
    }
  }

  return result;
}

/**
 * Get list of supported file extensions
 *
 * @returns {Array<string>} Array of supported file extensions (with dots)
 */
function getSupportedFileExtensions() {
  // Return the constant list, ensuring uniqueness just in case
  return [...new Set(ALL_SUPPORTED_EXTENSIONS)];
}

/**
 * Parse a .gitignore file and return an array of patterns
 *
 * @param {string} gitignorePath - Path to the .gitignore file
 * @returns {Array<string>} Array of gitignore patterns
 */
function parseGitignoreFile(gitignorePath) {
  try {
    if (!fs.existsSync(gitignorePath)) {
      return [];
    }

    const content = fs.readFileSync(gitignorePath, 'utf8');
    return content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((pattern) => {
        // Convert gitignore patterns to minimatch patterns
        if (pattern.startsWith('!')) {
          // Negated pattern
          return `!${pattern.substring(1)}`;
        }

        // Handle directory patterns (ending with /)
        if (pattern.endsWith('/')) {
          return `${pattern}**`;
        }

        return pattern;
      });
  } catch (error) {
    console.error(`Error parsing gitignore file ${gitignorePath}:`, error.message);
    return [];
  }
}

/**
 * Find all .gitignore files in a directory and its parent directories
 *
 * @param {string} startDir - Directory to start searching from
 * @returns {Array<string>} Array of .gitignore file paths
 */
function findGitignoreFiles(startDir) {
  const gitignoreFiles = [];
  let currentDir = startDir;

  // Check the current directory and all parent directories
  while (currentDir) {
    const gitignorePath = path.join(currentDir, '.gitignore');
    if (fs.existsSync(gitignorePath)) {
      gitignoreFiles.push(gitignorePath);
    }

    // Move to parent directory
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      // We've reached the root directory
      break;
    }
    currentDir = parentDir;
  }

  return gitignoreFiles;
}

/**
 * Find all .gitignore files that could affect a given file path
 * This includes .gitignore files in the file's directory, parent directories,
 * and any relevant subdirectories
 *
 * @param {string} filePath - Path to the file
 * @returns {Array<string>} Array of paths to relevant .gitignore files
 */
function findRelevantGitignoreFiles(filePath) {
  const fileDir = path.dirname(filePath);
  const gitignoreFiles = findGitignoreFiles(fileDir);

  // Sort gitignore files by directory depth (deepest first)
  // This ensures that more specific (nested) .gitignore files take precedence
  gitignoreFiles.sort((a, b) => {
    const depthA = a.split(path.sep).length;
    const depthB = b.split(path.sep).length;
    return depthB - depthA; // Sort descending (deepest first)
  });

  return gitignoreFiles;
}

/**
 * Check if a file should be excluded based on gitignore patterns
 *
 * @param {string} filePath - Path to the file
 * @param {Array<string>} patterns - Array of gitignore patterns
 * @param {string} baseDir - Base directory for relative paths
 * @returns {boolean} Whether the file should be excluded
 */
function isExcludedByGitignore(filePath, patterns, baseDir) {
  // Convert absolute path to relative path from baseDir
  const relativePath = path.relative(baseDir, filePath);

  // Check each pattern
  let excluded = false;

  for (const pattern of patterns) {
    const isNegated = pattern.startsWith('!');
    const actualPattern = isNegated ? pattern.substring(1) : pattern;

    if (minimatch(relativePath, actualPattern, { dot: true })) {
      excluded = !isNegated; // If negated, this file is explicitly included
    }
  }

  return excluded;
}

/**
 * Checks if a file path looks like a test file based on common patterns.
 * Tries to be relatively language/framework agnostic.
 * @param {string} filePath - Path to the file.
 * @returns {boolean} True if the path matches test patterns, false otherwise.
 */
function isTestFile(filePath) {
  if (!filePath) return false;
  const lowerPath = filePath.toLowerCase();
  // Common patterns: /__tests__/, /tests/, /specs/, _test., _spec., .test., .spec.
  // Ensure delimiters are present or it's in a specific test directory.
  // Checks for directory names or common patterns immediately preceding the file extension.
  const testPattern = /(\/__tests__\/|\/tests?\/|\/specs?\/|_test\.|_spec\.|\.test\.|\.spec\.)/i;
  return testPattern.test(lowerPath);
}

// +++ Add isDocumentationFile helper from embeddings.js +++
function isDocumentationFile(filePath, language) {
  const lowerPath = filePath.toLowerCase();
  const filename = lowerPath.split('/').pop();
  const extension = path.extname(lowerPath);

  // 1. Explicitly identify common code file extensions as NOT documentation
  if (CODE_EXTENSIONS.includes(extension)) {
    return false;
  }

  // 2. Check for specific documentation extensions
  if (DOCUMENTATION_EXTENSIONS.includes(extension)) {
    return true;
  }

  // 3. Check for universally accepted file names (case-insensitive)
  const docFilenames = ['readme', 'license', 'contributing', 'changelog', 'copying'];
  const filenameWithoutExt = filename.substring(0, filename.length - (extension.length || 0));
  if (docFilenames.includes(filenameWithoutExt)) {
    return true;
  }

  // 4. Check for common documentation directories (less reliable but useful)
  const docDirs = ['/docs/', '/documentation/', '/doc/', '/wiki/', '/examples/', '/guides/'];
  if (docDirs.some((dir) => lowerPath.includes(dir))) {
    return true;
  }

  // 5. Check for other common documentation terms in filename (lowest priority)
  const docTerms = ['guide', 'tutorial', 'manual', 'howto'];
  if (docTerms.some((term) => filename.includes(term))) {
    return true;
  }

  // 6. Special case for plain text files that look like docs
  if (extension === '.txt') {
    if (docFilenames.includes(filenameWithoutExt) || docTerms.some((term) => filename.includes(term))) {
      return true;
    }
  }

  // Removed project-specific config file checks

  return false;
}
// +++ End added helper +++

/**
 * Check if a file should be processed based on its path and content
 *
 * @param {string} filePath - Path to the file
 * @param {string} content - Content of the file (optional)
 * @param {Object} options - Additional options
 * @param {Array<string>} options.excludePatterns - Patterns to exclude
 * @param {boolean} options.respectGitignore - Whether to respect .gitignore files
 * @param {string} options.baseDir - Base directory for relative paths
 * @returns {boolean} Whether the file should be processed
 */
function shouldProcessFile(filePath, content = '', options = {}) {
  const { excludePatterns = [], respectGitignore = true, baseDir = process.cwd() } = options;

  // Skip files that are too large (>1MB)
  try {
    const stats = fs.statSync(filePath);
    if (stats.size > 1024 * 1024) {
      return false;
    }
  } catch (error) {
    // If we can't get file stats, assume it's processable
  }

  // Skip binary files
  const extension = path.extname(filePath).toLowerCase();
  const binaryExtensions = [
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

  if (binaryExtensions.includes(extension)) {
    return false;
  }

  // Skip node_modules, dist, build directories
  const skipDirs = ['node_modules', 'dist', 'build', '.git', 'coverage', 'vendor'];

  if (skipDirs.some((dir) => filePath.includes(`/${dir}/`))) {
    return false;
  }

  // Skip files that are likely to be generated
  const skipFilePatterns = [/\.min\.(js|css)$/, /\.bundle\.(js|css)$/, /\.generated\./, /\.d\.ts$/];

  if (skipFilePatterns.some((pattern) => pattern.test(filePath))) {
    return false;
  }

  // Check custom exclude patterns
  if (excludePatterns.length > 0) {
    const relativePath = path.relative(baseDir, filePath);
    if (excludePatterns.some((pattern) => minimatch(relativePath, pattern, { dot: true }))) {
      return false;
    }
  }

  // Check gitignore patterns if enabled
  if (respectGitignore) {
    try {
      // Use git check-ignore to determine if a file is ignored
      // This is the most accurate way to check as it uses Git's own ignore logic
      execSync(`git check-ignore -q "${filePath}"`, { stdio: 'ignore' });

      // If we get here, the file is ignored by git
      return false;
    } catch (error) {
      // If git check-ignore exits with non-zero status, the file is not ignored
      // This is expected behavior, so we continue processing
    }
  }

  return true;
}

/**
 * Slugify text for use in IDs.
 * @param {string} text - The text to slugify.
 * @returns {string} A slugified string.
 */
function slugify(text) {
  if (!text) return '';
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-') // Replace spaces with -
    .replace(/[^\w-]+/g, '') // Remove all non-word chars
    .replace(/--+/g, '-'); // Replace multiple - with single -
}

/**
 * Extracts chunks from Markdown content based on H2 and H3 headings,
 * and also extracts the first H1 heading as the document title.
 * @param {string} filePath - The absolute path to the file.
 * @param {string} content - The Markdown content of the file.
 * @param {string} relativePath - The relative path of the file.
 * @returns {Object} An object containing `chunks` (Array) and `documentH1` (string|null).
 *                   Each chunk object contains:
 *                          `content`, `heading` (H2/H3 text),
 *                          `original_document_path`, `start_line_in_doc`, `language`.
 */
function extractMarkdownChunks(filePath, content, relativePath) {
  const chunks = [];
  let documentH1 = null;
  if (!content || typeof content !== 'string') return { chunks, documentH1 };

  const lines = content.split('\n');
  let currentChunkLines = [];
  let currentH2H3Heading = null; // Stores the H2 or H3 heading for the current chunk
  let chunkStartLine = 1;
  let inCodeBlock = false;
  let h1Found = false;
  let linesProcessedForH1 = 0; // Debug counter

  const h1Regex = /^#\s*(.*)/; // Regex for H1 (allow zero or more spaces after #)
  const h2h3Regex = /^(##|###)\s+(.*)/; // Regex for H2 or H3

  // --- Debug log: Initial state for the file ---
  // console.log(`[extractMarkdownChunks DEBUG] Processing: ${filePath}. Content length: ${content.length}`); // Can be too verbose

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmedLine = line.trim();

    if (trimmedLine.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
    }

    if (!h1Found && linesProcessedForH1 < 5) {
      linesProcessedForH1++;
      // --- Debug log: Checking line for H1 ---
      if (filePath.includes('README.md') || filePath.includes('RUNBOOK.md')) {
        // Log only for specific files to reduce noise
        console.log(`[extractMarkdownChunks DEBUG] File: ${filePath}, Line ${i + 1} (trimmed): "${trimmedLine}", Attempting H1 match.`);
      }
      const h1Match = trimmedLine.match(h1Regex);
      if (h1Match) {
        documentH1 = h1Match[1].trim();
        h1Found = true;
        console.log(`[extractMarkdownChunks DEBUG] H1 FOUND for ${filePath}: "${documentH1}" on line ${i + 1}`);
      } else if (filePath.includes('README.md') || filePath.includes('RUNBOOK.md')) {
        if (linesProcessedForH1 <= 5 && trimmedLine.startsWith('#')) {
          // If it starts with # but didn't match
          console.log(
            `[extractMarkdownChunks DEBUG] File: ${filePath}, Line ${i + 1}: Starts with # but H1Regex DID NOT match "${trimmedLine}"`
          );
        }
      }
    }

    const h2h3Match = !inCodeBlock && trimmedLine.match(h2h3Regex);

    if (h2h3Match) {
      // Found an H2 or H3 heading, finalize the previous chunk if it has content
      if (currentChunkLines.length > 0 && currentChunkLines.join('\n').trim().length > 0) {
        chunks.push({
          content: currentChunkLines.join('\n').trim(),
          heading: currentH2H3Heading, // Heading of the *previous* H2/H3 chunk
          original_document_path: relativePath,
          start_line_in_doc: chunkStartLine,
          language: 'markdown',
        });
      }
      // Start a new H2/H3 chunk
      currentH2H3Heading = h2h3Match[2].trim();
      currentChunkLines = [line]; // Include H2/H3 heading line in the new chunk's content
      chunkStartLine = i + 1;
    } else {
      // Not an H1 or H2/H3 heading line (or H1 already found), add to current chunk
      // This also correctly captures content before the first H2/H3 heading (under an H1 or if no H1).
      currentChunkLines.push(line);
    }
  }

  // Add the last processed chunk if it has content
  if (currentChunkLines.length > 0 && currentChunkLines.join('\n').trim().length > 0) {
    chunks.push({
      content: currentChunkLines.join('\n').trim(),
      heading: currentH2H3Heading, // H2/H3 heading of the last chunk
      original_document_path: relativePath,
      start_line_in_doc: chunkStartLine,
      language: 'markdown',
    });
  }

  // If no H2/H3 chunks were created (e.g., file has only H1 and paragraphs, or just paragraphs)
  // treat the whole file content (that wasn't part of H1 line itself if H1 was first line) as a single chunk.
  if (chunks.length === 0 && content.trim().length > 0) {
    let initialContent = content.trim();
    // If H1 was the very first line and we captured it, remove it from this single chunk content
    if (documentH1 && lines.length > 0 && lines[0].trim().match(h1Regex)) {
      initialContent = lines.slice(1).join('\n').trim();
    }
    if (initialContent.length > 0) {
      chunks.push({
        content: initialContent,
        heading: null, // No H2/H3 heading for this single chunk
        original_document_path: relativePath,
        start_line_in_doc: h1Found && lines.length > 0 && lines[0].trim().match(h1Regex) ? 2 : 1,
        language: 'markdown',
      });
    }
  }

  if (!documentH1) {
    documentH1 = path.basename(filePath).replace(path.extname(filePath), '');
    console.log(`[extractMarkdownChunks DEBUG] H1 NOT FOUND for ${filePath}. Using fallback title: "${documentH1}"`);
  }

  return { chunks: chunks.filter((chunk) => chunk.content.length > 0), documentH1 };
}
// --- END Moved Functions ---

// --- Context Inference Helpers (Moved from cag-analyzer.js) ---

// TODO: Implement more robustly. This is a starting heuristic.
function inferContextFromCodeContent(codeContent, language) {
  const context = {
    area: 'Unknown', // "Frontend" | "Backend" | "Tooling" | "GeneralJS_TS" | "Unknown"
    keywords: [], // string[]
    dominantTech: [], // string[]
  };
  const lowerCode = codeContent.toLowerCase();

  // Area inference (very basic for now)
  if (language === 'javascript' || language === 'typescript') {
    if (
      lowerCode.includes('react') ||
      lowerCode.includes('usestate') ||
      lowerCode.includes('useeffect') ||
      lowerCode.includes('angular') ||
      lowerCode.includes('vue') ||
      lowerCode.includes('document.getelementbyid') ||
      lowerCode.includes('jsx') ||
      lowerCode.includes('.tsx')
    ) {
      context.area = 'Frontend';
      if (lowerCode.includes('react')) context.dominantTech.push('React');
      if (lowerCode.includes('angular')) context.dominantTech.push('Angular');
      if (lowerCode.includes('vue')) context.dominantTech.push('Vue');
    } else if (
      lowerCode.includes("require('express')") ||
      lowerCode.includes('http.createserver') ||
      lowerCode.includes('fs.readfilesync') ||
      lowerCode.includes('process.env')
    ) {
      context.area = 'Backend';
      if (lowerCode.includes('express')) context.dominantTech.push('Node.js/Express');
      else context.dominantTech.push('Node.js');
    } else {
      context.area = 'GeneralJS_TS';
    }
  } else if (language === 'python') {
    if (lowerCode.includes('django') || lowerCode.includes('flask')) {
      context.area = 'Backend';
      if (lowerCode.includes('django')) context.dominantTech.push('Django');
      if (lowerCode.includes('flask')) context.dominantTech.push('Flask');
    } else {
      context.area = 'GeneralPython'; // Or just "Backend"
    }
  }
  // Add more language-specific heuristics here

  const commonTechWords = ['api', 'component', 'module', 'function', 'class', 'hook', 'service', 'database', 'query', 'state', 'props'];
  commonTechWords.forEach((word) => {
    if (lowerCode.includes(word)) context.keywords.push(word);
  });
  context.keywords = [...new Set(context.keywords)];
  context.dominantTech = [...new Set(context.dominantTech)];

  return context;
}

// Full, corrected, and enhanced inferContextFromDocumentContent:
function inferContextFromDocumentContent(docPath, h1Content, chunksSample = [], languageOfCodeSnippet = 'typescript') {
  const context = {
    area: 'Unknown',
    keywords: [],
    dominantTech: [],
    isGeneralPurposeReadmeStyle: false,
    docPath: docPath,
  };

  const lowerDocPath = docPath.toLowerCase();
  const lowerH1 = (h1Content || '').toLowerCase();

  // 1. Prepare and Prioritize Text for Analysis
  let combinedChunkText = '';
  let charCount = 0;
  const MAX_CHARS_FROM_CHUNKS = 2000;

  for (const chunk of chunksSample) {
    // Iterate over potentially all sample chunks from findSimilarCode
    if (charCount >= MAX_CHARS_FROM_CHUNKS) break;
    const chunkContentLower = (chunk.content || '').toLowerCase();
    const chunkHeadingLower = (chunk.heading_text || '').toLowerCase();
    let textToAppend = '';
    if (chunkHeadingLower && chunkHeadingLower !== lowerH1) {
      textToAppend += chunkHeadingLower + ' ';
    }
    textToAppend += chunkContentLower;

    combinedChunkText += ' ' + textToAppend.substring(0, MAX_CHARS_FROM_CHUNKS - charCount);
    charCount += textToAppend.length;
  }

  const lowerDocPathFilename = path.basename(lowerDocPath).replace(/\.(md|rst|txt|mdx)$/i, '');
  // Give H1 significant weight, also include filename (cleaned of hyphens)
  let primaryTextForAnalysis = `${lowerH1} ${lowerH1} ${lowerDocPathFilename.replace(/-/g, ' ')}`;
  let fullTextForAnalysis = `${primaryTextForAnalysis} ${combinedChunkText}`.replace(/\s+/g, ' ').trim();

  if (!fullTextForAnalysis.trim()) {
    // If absolutely no text content after H1, filename, and chunks
    if (lowerDocPath)
      fullTextForAnalysis = lowerDocPath; // Fallback to path for keyword extraction if all else fails
    else {
      context.area = 'UndeterminedByContent';
      return context; // Early exit if no text to analyze at all
    }
  }

  // --- 2. Dominant Technology Detection (Score-based) ---
  const techScores = {
    React: 0,
    Angular: 0,
    Vue: 0,
    'Node.js': 0,
    Express: 0,
    NestJS: 0,
    Python: 0,
    Django: 0,
    Flask: 0,
    FastAPI: 0,
    Java: 0,
    Spring: 0,
    CSharp: 0,
    '.NET': 0,
    Ruby: 0,
    Rails: 0,
    PHP: 0,
    Laravel: 0,
    Go: 0,
    GraphQL: 0,
    Apollo: 0,
    Docker: 0,
    Kubernetes: 0,
  };

  // Tech keywords and regexes - Stronger signals get higher scores
  if (
    fullTextForAnalysis.match(
      /react(\s|-)?dom|usestate\(|useeffect\(|styled-components|@emotion|next\.js|gatsby|\.jsx|\.tsx|react component|functional component/i
    )
  )
    techScores['React'] += 2.5;
  if (fullTextForAnalysis.match(/@angular\/core|ngmodule|ngoninit|rxjs|ngrx|angular component/i)) techScores['Angular'] += 2.5;
  if (fullTextForAnalysis.match(/vue\.js|vuex|nuxt\.js|vuetify|vue component|v-if|v-for/i)) techScores['Vue'] += 2.5;
  if (
    fullTextForAnalysis.match(
      /require\(['"]express['"]\)|app\.listen\(|express\.router|nestjs|@nestjs\/common|fastify|node server|http\.createserver/i
    )
  ) {
    techScores['Node.js'] += 2;
    techScores['Express'] += fullTextForAnalysis.includes('express') ? 1.5 : 0;
    techScores['NestJS'] += fullTextForAnalysis.includes('nestjs') ? 1 : 0;
  }
  if (fullTextForAnalysis.match(/python manage\.py|django-admin|from django\.|@csrf_exempt|flask app|@app\.route|python api|fastapi/i)) {
    techScores['Python'] += 2;
    techScores['Django'] += fullTextForAnalysis.includes('django') ? 1.5 : 0;
    techScores['Flask'] += fullTextForAnalysis.includes('flask') ? 1.5 : 0;
    techScores['FastAPI'] += fullTextForAnalysis.includes('fastapi') ? 1 : 0;
  }
  if (fullTextForAnalysis.match(/java\.lang|spring boot|@springapplication|org\.springframework|maven|gradle build|java api|jakarta ee/i)) {
    techScores['Java'] += 2;
    techScores['Spring'] += fullTextForAnalysis.includes('spring') ? 1.5 : 0;
  }
  if (
    fullTextForAnalysis.match(/csharp|system\.linq|asp\.net core|\.net framework|namespace\s+\w+/i) &&
    !fullTextForAnalysis.includes('java')
  ) {
    techScores['CSharp'] += 2;
    techScores['.NET'] += 1;
  }
  if (
    fullTextForAnalysis.match(
      /graphql\b|apollo-server|apollo-client|resolver function|mutation type|query type|sdl|schema definition language|dataloader/i
    )
  ) {
    techScores['GraphQL'] += 2;
    techScores['Apollo'] += fullTextForAnalysis.match(/apollo-server|apollo-client/i) ? 1.5 : 0;
  }
  if (fullTextForAnalysis.match(/dockerfile|docker-compose|kubernetes manifest|helm chart|kubectl apply|containerization/i)) {
    techScores['Docker'] += 1.5;
    techScores['Kubernetes'] += 1.5;
  }
  // Weaker tech terms (lower score or boost if primary signals already present)
  if (fullTextForAnalysis.includes('react') && techScores['React'] < 2) techScores['React'] += 0.5;
  if (fullTextForAnalysis.includes('angular') && techScores['Angular'] < 2) techScores['Angular'] += 0.5;
  if (fullTextForAnalysis.includes('vue') && techScores['Vue'] < 2) techScores['Vue'] += 0.5;
  if (fullTextForAnalysis.includes('node.js')) techScores['Node.js'] += 0.5; // "node" alone is too generic
  if (fullTextForAnalysis.includes('python')) techScores['Python'] += 0.5;
  if (fullTextForAnalysis.includes('java') && !fullTextForAnalysis.includes('javascript')) techScores['Java'] += 0.5;
  if (fullTextForAnalysis.includes('c#')) techScores['CSharp'] += 0.5;
  if (fullTextForAnalysis.includes('graphql') && techScores['GraphQL'] < 2) techScores['GraphQL'] += 0.5;

  const DOMINANT_TECH_THRESHOLD = 1.8; // Might need tuning
  for (const tech in techScores) {
    if (techScores[tech] >= DOMINANT_TECH_THRESHOLD) {
      context.dominantTech.push(tech);
    }
  }
  context.dominantTech = [...new Set(context.dominantTech)];

  // --- 3. Area Inference (Content-First, Score-Based, with Path/H1 hints) ---
  const areaScores = {
    Frontend: 0,
    Backend: 0,
    DevOps: 0,
    Mobile: 0,
    DataScience: 0,
    ToolingInternal: 0,
    GeneralTechnical: 0,
    GeneralProjectDoc: 0,
  };
  const areaKeywords = {
    Frontend: {
      'user interface': 2,
      'ui/ux': 2,
      'client-side': 1.5,
      'browser api': 1,
      css: 0.5,
      html: 0.5,
      'dom manipulation': 1,
      accessibility: 1.5,
      'responsive design': 1.5,
      'frontend performance': 1.5,
      'component library': 2,
      'single page application': 1.5,
      'frontend routing': 1.5,
      'rendering patterns': 1.5,
      'web components': 1,
    },
    Backend: {
      'server-side': 2,
      'api endpoint': 2,
      'database schema': 1.5,
      microservice: 1.5,
      'restful api': 1.5,
      grpc: 1,
      'authentication server': 2,
      'authorization logic': 2,
      'data persistence': 1.5,
      'message queue': 1,
      'system architecture': 1.5,
      'api gateway': 1.5,
      'background job': 1,
      'data processing pipeline': 1.5,
      'api security': 1.5,
      resolver: 1,
      dataloader: 1,
    },
    DevOps: {
      'ci/cd': 2,
      'continuous integration': 2,
      'continuous deployment': 2,
      'infrastructure as code': 1.5,
      terraform: 1,
      ansible: 1,
      jenkins: 0.5,
      monitoring: 1.5,
      'logging infrastructure': 1.5,
      'alerting system': 1.5,
      'cloud provider': 0.5,
      aws: 0.5,
      azure: 0.5,
      gcp: 0.5,
      kubernetes: 1.5,
      docker: 1,
      'container orchestration': 1.5,
    },
    Mobile: {
      'ios development': 2,
      'android development': 2,
      swiftui: 1.5,
      'kotlin multiplatform': 1.5,
      'react native': 1.5,
      'flutter ui': 1.5,
      'mobile application': 2,
      'push notification service': 1,
    },
    DataScience: {
      'machine learning model': 2,
      'data analysis report': 2,
      'statistical modeling': 1.5,
      'pandas dataframe': 1,
      'numpy array': 1,
      'scikit-learn pipeline': 1,
      'tensorflow graph': 1,
      'pytorch tensor': 1,
      'jupyter notebook analysis': 0.5,
    },
    ToolingInternal: {
      'cli tool': 2,
      'developer utility': 2,
      'build script': 1.5,
      'automation script': 1.5,
      'linter configuration': 1,
      'code generator': 1.5,
      'internal sdk': 2,
      'testing framework utilities': 1.5,
      'debug tool': 1,
      'profiling tool': 1,
    },
    GeneralTechnical: {
      'coding standard': 1.5,
      'software best practice': 1.5,
      'style guide document': 1.5,
      'contribution guidelines': 1,
      'design pattern explanation': 2,
      'algorithm design': 1,
      'data structure theory': 1,
      'version control strategy': 1,
      'git workflow guide': 1,
      'architectural overview': 2,
      'code quality': 1.5,
      maintainability: 1.5,
    },
    GeneralProjectDoc: {
      'project overview': 1.5,
      'readme main': 1,
      'runbook operations': 1,
      'setup instructions': 1,
      'getting started guide': 1,
      'table of contents': 0.5,
      'license information': 0.5,
      'changelog history': 0.5,
      'team structure': 0.5,
      'meeting notes': 0.5,
    },
  };

  for (const area in areaKeywords) {
    for (const keyword in areaKeywords[area]) {
      if (fullTextForAnalysis.includes(keyword)) {
        areaScores[area] += areaKeywords[area][keyword];
      }
    }
  }

  // Boost area scores based on dominantTech
  if (context.dominantTech.some((tech) => ['React', 'Angular', 'Vue'].includes(tech))) areaScores.Frontend += 3;
  if (
    context.dominantTech.some((tech) =>
      [
        'Node.js',
        'Express',
        'NestJS',
        'Django',
        'Flask',
        'FastAPI',
        'Spring',
        '.NET',
        'Rails',
        'Laravel',
        'Go',
        'GraphQL',
        'Apollo',
      ].includes(tech)
    )
  )
    areaScores.Backend += 3;
  if (context.dominantTech.some((tech) => ['Docker', 'Kubernetes'].includes(tech))) areaScores.DevOps += 2.5;
  if (context.dominantTech.length > 0 && areaScores.ToolingInternal > 0.5) areaScores.ToolingInternal += 1.5;

  // Path-based hints (additive, can help sway scores)
  if (
    lowerDocPath.includes('/tools/') ||
    lowerDocPath.includes('/scripts/') ||
    lowerDocPath.includes('/cli/') ||
    lowerH1.includes(' cli') ||
    lowerH1.includes(' tool')
  )
    areaScores.ToolingInternal += 3;
  if (
    lowerDocPath.includes('/api/') ||
    lowerDocPath.includes('/server/') ||
    lowerDocPath.includes('/db/') ||
    lowerDocPath.includes('/backend/') ||
    lowerH1.includes(' api') ||
    lowerH1.includes(' server') ||
    lowerH1.includes(' backend')
  )
    areaScores.Backend += 3;
  if (
    lowerDocPath.includes('/frontend/') ||
    lowerDocPath.includes('/ui/') ||
    lowerDocPath.includes('/components/') ||
    lowerDocPath.includes('/views/') ||
    lowerDocPath.includes('/pages/') ||
    lowerH1.includes(' frontend') ||
    lowerH1.includes(' user interface')
  )
    areaScores.Frontend += 3;
  if (
    lowerDocPath.endsWith('readme.md') ||
    lowerDocPath.endsWith('runbook.md') ||
    lowerDocPath.endsWith('contributing.md') ||
    lowerDocPath.endsWith('changelog.md')
  )
    areaScores.GeneralProjectDoc += 2;
  if (lowerH1.includes('error handling') && (areaScores.Backend > 0 || areaScores.Frontend > 0)) {
    // If error handling and some FE/BE signal, boost that area.
    if (areaScores.Backend > areaScores.Frontend) areaScores.Backend += 1;
    else if (areaScores.Frontend > areaScores.Backend) areaScores.Frontend += 1;
    else {
      areaScores.GeneralTechnical += 0.5;
    } // If ambiguous, lean general technical
  }

  let maxScore = 0;
  let determinedArea = 'Unknown';
  const MIN_AREA_CONFIDENCE_SCORE = 3.5; // Increased threshold slightly

  for (const area in areaScores) {
    if (areaScores[area] > maxScore) {
      maxScore = areaScores[area];
      determinedArea = area;
    }
  }

  if (maxScore >= MIN_AREA_CONFIDENCE_SCORE) {
    context.area = determinedArea;
  } else if (areaScores.GeneralTechnical >= 2.0) {
    context.area = 'GeneralTechnical';
  } else if (areaScores.GeneralProjectDoc >= 1.5) {
    context.area = 'GeneralProjectDoc';
  } else {
    context.area = 'Unknown';
  }

  // --- isGeneralPurposeReadmeStyle ---
  let readmeStylePoints = 0;
  const readmeKeywords = {
    'getting started': 2,
    installation: 2,
    setup: 2,
    'how to run': 2,
    usage: 1,
    configuration: 1,
    deployment: 1,
    troubleshooting: 1,
    prerequisites: 1,
    'table of contents': 1,
    contributing: 0.5,
    license: 0.5,
    overview: 1,
    introduction: 1, // Removed ## from here
    purpose: 1,
    'project structure': 0.5,
  };
  for (const keyword in readmeKeywords) {
    if (fullTextForAnalysis.includes(keyword)) {
      readmeStylePoints += readmeKeywords[keyword];
    }
  }
  const isRootFile = !lowerDocPath.substring(0, lowerDocPath.lastIndexOf('/')).includes('/');
  if ((isRootFile && lowerDocPath.startsWith('readme') && readmeStylePoints >= 3) || readmeStylePoints >= 5) {
    context.isGeneralPurposeReadmeStyle = true;
  }
  // If classified as a general project doc, it usually has readme style.
  if (context.area === 'GeneralProjectDoc') {
    context.isGeneralPurposeReadmeStyle = true;
  }
  // Tooling READMEs are often general purpose style.
  if (context.area === 'Tooling' && lowerDocPath.includes('readme') && readmeStylePoints >= 2) {
    context.isGeneralPurposeReadmeStyle = true;
  }

  // --- Extract Keywords ---
  context.keywords.push(...context.dominantTech.map((t) => t.toLowerCase()));
  if (lowerH1) {
    lowerH1
      .split(/[^a-z0-9-]+/g)
      .filter((word) => word.length > 3 && !['the', 'for', 'and', 'with', 'into', 'about', 'using', 'docs', 'this', 'that'].includes(word))
      .slice(0, 5)
      .forEach((kw) => context.keywords.push(kw));
  }
  const generalTechKeywordsForExtraction = [
    'architecture',
    'pattern',
    'guideline',
    'component',
    'service',
    'api',
    'database',
    'test',
    'error',
    'state',
    'auth',
    'performance',
    'security',
    'style',
    'translation',
    'module',
    'structure',
    'design',
    'principle',
    'best practice',
    'convention',
    'log',
    'deploy',
    'build',
    'config',
    'resolver',
    'dataloader',
    'schema',
  ];
  generalTechKeywordsForExtraction.forEach((kw) => {
    if (fullTextForAnalysis.includes(kw)) context.keywords.push(kw);
  });
  context.keywords = [...new Set(context.keywords)].slice(0, 15);

  return context;
}

// --- END Context Inference Helpers ---

export {
  detectLanguageFromExtension,
  detectFileType,
  getSupportedFileExtensions,
  shouldProcessFile,
  parseGitignoreFile,
  findGitignoreFiles,
  findRelevantGitignoreFiles,
  isExcludedByGitignore,
  isTestFile,
  isDocumentationFile,
  slugify,
  extractMarkdownChunks,
  inferContextFromCodeContent,
  inferContextFromDocumentContent,
};
