/**
 * Language Detection Module
 *
 * This module provides utilities for detecting programming languages
 * and file types from file extensions and content analysis.
 */

import path from 'path';
import { EXTENSION_TO_LANGUAGE_MAP, ALL_SUPPORTED_EXTENSIONS } from './constants.js';

/**
 * Detect programming language from file extension
 *
 * @param {string} extension - File extension (including the dot)
 * @returns {string|null} Detected language or null if unknown
 *
 * @example
 * const language = detectLanguageFromExtension('.ts');
 * // Returns: 'typescript'
 */
export function detectLanguageFromExtension(extension) {
  // Normalize extension to lowercase with leading dot
  const normalizedExt = extension.toLowerCase();
  if (!normalizedExt.startsWith('.')) {
    extension = `.${normalizedExt}`;
  } else {
    extension = normalizedExt;
  }

  // Check if the extension is supported
  if (!ALL_SUPPORTED_EXTENSIONS.includes(extension)) {
    return 'unknown';
  }

  // Use the centralized extension-to-language mapping from constants
  return EXTENSION_TO_LANGUAGE_MAP[extension] || 'unknown';
}

/**
 * Detect file type and framework from file path and content
 *
 * @param {string} filePath - Path to the file
 * @param {string} content - Content of the file (optional)
 * @returns {Object} File type information including language, framework, and flags
 *
 * @example
 * const fileInfo = detectFileType('src/components/Button.tsx', 'import React from "react"');
 * // Returns: { path: '...', extension: '.tsx', language: 'typescript', framework: 'react', ... }
 */
export function detectFileType(filePath, content = '') {
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
