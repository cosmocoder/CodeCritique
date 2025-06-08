/**
 * Configuration Loader Module
 *
 * This module provides functionality to load and manage configuration settings
 * for different programming languages and file types. It makes the code review tool
 * technology-agnostic by loading appropriate configurations dynamically.
 */

import { detectFileType, detectLanguageFromExtension } from './utils.js';
import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';

// Get __dirname equivalent in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to default configuration
const DEFAULT_CONFIG_PATH = path.join(__dirname, 'default-config.js');

// Cache for loaded configurations
const configCache = new Map();

/**
 * Load configuration for a specific language
 *
 * @param {string} language - Programming language
 * @returns {Object} Configuration for the language
 */
function loadLanguageConfig(language) {
  // Check cache first
  if (configCache.has(`language:${language}`)) {
    return configCache.get(`language:${language}`);
  }

  try {
    // Ensure language is a valid string
    const safeLanguage = language || 'unknown';

    // Get language-specific configuration
    const config = defaultConfig?.languages?.[safeLanguage] || defaultConfig?.languages?.default || {};

    // Cache the result
    configCache.set(`language:${language}`, config);

    return config;
  } catch (error) {
    console.error(`Error loading configuration for language ${language}:`, error.message);
    return {};
  }
}

/**
 * Load block delimiters for a specific language
 *
 * @param {string} language - Programming language
 * @returns {Array<Object>} Array of block delimiter objects
 */
// Load default configuration once at module initialization
let defaultConfig;
try {
  // Use a dynamic import with .then() to load the configuration synchronously
  import(DEFAULT_CONFIG_PATH).then((config) => {
    defaultConfig = config.default;
  });
} catch (error) {
  console.error(`Error loading default configuration:`, error.message);
  defaultConfig = {
    languages: {
      default: {
        blockDelimiters: [
          { type: 'brace', begin: /{/, end: /}/ },
          { type: 'indentation', begin: /:$/, end: /^(?!\s)/ },
        ],
        blockStarterPatterns: [/(\w+)\s*\([^)]*\)\s*[{:]/, /(\w+)\s*[{:]/],
      },
    },
  };
}

function loadBlockDelimiters(language) {
  try {
    // Ensure language is a valid string
    const safeLanguage = language || 'unknown';

    // Get language-specific block delimiters or fall back to default
    const config = defaultConfig?.languages?.[safeLanguage] || defaultConfig?.languages?.default;

    return (
      config?.blockDelimiters ||
      defaultConfig?.languages?.default?.blockDelimiters || [
        { type: 'brace', begin: /{/, end: /}/ },
        { type: 'indentation', begin: /:$/, end: /^(?!\s)/ },
      ]
    );
  } catch (error) {
    console.error(`Error loading block delimiters for ${language}:`, error.message);

    // Return a sensible default for most languages
    return [
      { type: 'brace', begin: /{/, end: /}/ },
      { type: 'indentation', begin: /:$/, end: /^(?!\s)/ },
    ];
  }
}

/**
 * Load block starter patterns for a specific language
 *
 * @param {string} language - Programming language
 * @returns {Array<RegExp>} Array of regular expressions for block starters
 */
function loadBlockStarterPatterns(language) {
  try {
    // Ensure language is a valid string
    const safeLanguage = language || 'unknown';

    // Get language-specific block starter patterns or fall back to default
    const config = defaultConfig?.languages?.[safeLanguage] || defaultConfig?.languages?.default;

    // Ensure we return an array
    const patterns = config?.blockStarterPatterns ||
      defaultConfig?.languages?.default?.blockStarterPatterns || [
        /function\s+(\w+)\s*\(/,
        /class\s+(\w+)/,
        /(\w+)\s*=\s*function\s*\(/,
        /const\s+(\w+)\s*=\s*\(.*\)\s*=>/,
        /(\w+)\s*\(.*\)\s*{/,
      ];

    return Array.isArray(patterns) ? patterns : [];
  } catch (error) {
    console.error(`Error loading block starter patterns for ${language}:`, error.message);

    // Return a sensible default for most languages
    return [/function\s+(\w+)\s*\(/, /class\s+(\w+)/, /(\w+)\s*=\s*function\s*\(/, /const\s+(\w+)\s*=\s*\(.*\)\s*=>/, /(\w+)\s*\(.*\)\s*{/];
  }
}

/**
 * Load pattern configuration for a specific language
 *
 * @param {string} language - Programming language
 * @returns {Array<string>} Array of pattern categories
 */
function loadPatternConfig(language) {
  try {
    // Ensure language is a valid string
    const safeLanguage = language || 'unknown';

    // Get language-specific pattern configuration or fall back to default
    const config = defaultConfig?.languages?.[safeLanguage] || defaultConfig?.languages?.default;

    return (
      config?.patternCategories ||
      defaultConfig?.languages?.default?.patternCategories || [
        'codeFormatting',
        'comments',
        'imports',
        'performance',
        'security',
        'naming',
        'errorHandling',
      ]
    );
  } catch (error) {
    console.error(`Error loading pattern configuration for ${language}:`, error.message);

    // Return a sensible default set of pattern categories
    return ['codeFormatting', 'comments', 'imports', 'performance', 'security', 'naming', 'errorHandling'];
  }
}

/**
 * Get prompt template for a specific file type
 *
 * @param {string} fileType - File type or language
 * @returns {string} Prompt template for the file type
 */
function getPromptForFileType(fileType) {
  try {
    // Get file type specific prompt template or fall back to default
    const promptTemplate = defaultConfig?.promptTemplates?.[fileType] || defaultConfig?.promptTemplates?.default;

    return (
      promptTemplate ||
      `
You are an expert code reviewer with deep knowledge of software engineering principles, design patterns, and best practices.
Review the following {{language}} code and provide constructive feedback:

CODE:
{code}

Please analyze the code for:
1. Potential bugs or errors
2. Performance issues
3. Maintainability concerns
4. Adherence to best practices
5. Security vulnerabilities

Focus on providing actionable feedback with specific suggestions for improvement.
`
    );
  } catch (error) {
    console.error(`Error loading prompt template for ${fileType}:`, error.message);

    // Return a generic prompt template
    return `
You are an expert code reviewer with deep knowledge of software engineering principles, design patterns, and best practices.
Review the following {{language}} code and provide constructive feedback:

CODE:
{code}

Please analyze the code for:
1. Potential bugs or errors
2. Performance issues
3. Maintainability concerns
4. Adherence to best practices
5. Security vulnerabilities

Focus on providing actionable feedback with specific suggestions for improvement.
`;
  }
}

/**
 * Load configuration for a specific file
 *
 * @param {string} filePath - Path to the file
 * @param {string} content - Content of the file (optional)
 * @returns {Object} Configuration for the file
 */
function loadConfigForFile(filePath, content = '') {
  // Detect file type and language
  const fileTypeInfo = detectFileType(filePath, content);
  const language = fileTypeInfo.language || 'unknown';

  // Get language configuration from default config
  const languageConfig = defaultConfig?.languages?.[language] || defaultConfig?.languages?.default || {};

  // Load framework-specific configuration if applicable
  let frameworkConfig = {};
  if (fileTypeInfo.framework) {
    try {
      // Get framework-specific configuration
      frameworkConfig = defaultConfig?.frameworks?.[fileTypeInfo.framework] || {};
    } catch (error) {
      console.error(`Error loading framework configuration for ${fileTypeInfo.framework}:`, error.message);
    }
  }

  // Merge configurations with framework taking precedence
  return {
    ...languageConfig,
    ...frameworkConfig,
    fileType: fileTypeInfo,
  };
}

export { loadBlockDelimiters, loadBlockStarterPatterns, loadPatternConfig, getPromptForFileType, loadConfigForFile };
