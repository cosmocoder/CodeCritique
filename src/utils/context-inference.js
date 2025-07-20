/**
 * Context Inference Module
 *
 * This module provides utilities for inferring context from code and document content,
 * including technology detection, area classification, and semantic analysis.
 */

import path from 'path';
import { openClassifier } from '../zero-shot-classifier-open.js';

/**
 * Infer context from code content using heuristic analysis
 *
 * @param {string} codeContent - The code content to analyze
 * @param {string} language - The detected programming language
 * @returns {Object} Context information including area, keywords, and dominant technologies
 *
 * @example
 * const context = inferContextFromCodeContent('import React from "react"', 'javascript');
 * // Returns: { area: 'Frontend', keywords: [...], dominantTech: ['React'] }
 */
export function inferContextFromCodeContent(codeContent, language) {
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

/**
 * Infer context from document content using advanced classification and analysis
 *
 * @param {string} docPath - Path to the document
 * @param {string} h1Content - H1 heading content
 * @param {Array} chunksSample - Sample chunks from the document for analysis
 * @returns {Promise<Object>} Context information with area classification and technology detection
 *
 * @example
 * const context = await inferContextFromDocumentContent('/docs/api.md', 'API Guide', chunks);
 * // Returns: { area: 'Backend', dominantTech: ['API', 'REST'], keywords: [...], ... }
 */
export async function inferContextFromDocumentContent(docPath, h1Content, chunksSample = []) {
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

  try {
    // Initialize classifier if needed
    await openClassifier.initialize();

    // --- 2. Use Open-Ended Classification ---
    const classification = await openClassifier.classifyDocument(fullTextForAnalysis);

    // Extract technologies directly from the classification
    context.dominantTech = classification.technologies.filter((t) => t.confidence >= 0.35).map((t) => t.technology);

    // --- 3. Area Inference based on domains and technologies ---
    let areaScore = {
      Frontend: 0,
      Backend: 0,
      FullStack: 0,
      Database: 0,
      DevOps: 0,
      Testing: 0,
      Security: 0,
      Architecture: 0,
      ToolingInternal: 0,
      GeneralProjectDoc: 0,
      Unknown: 0,
    };

    // Score based on domains
    classification.domains.forEach((domain) => {
      const domainLower = domain.domain.toLowerCase();
      const confidence = domain.confidence;

      if (domainLower.includes('frontend') || domainLower.includes('ui/ux')) {
        areaScore['Frontend'] += confidence;
      }
      if (domainLower.includes('backend') || domainLower.includes('api')) {
        areaScore['Backend'] += confidence;
      }
      if (domainLower.includes('database') || domainLower.includes('data')) {
        areaScore['Database'] += confidence;
      }
      if (domainLower.includes('devops') || domainLower.includes('infrastructure')) {
        areaScore['DevOps'] += confidence;
      }
      if (domainLower.includes('testing') || domainLower.includes('qa')) {
        areaScore['Testing'] += confidence;
      }
      if (domainLower.includes('security')) {
        areaScore['Security'] += confidence;
      }
      if (domainLower.includes('architecture')) {
        areaScore['Architecture'] += confidence;
      }
      if (domainLower.includes('tooling') || domainLower.includes('developer tools')) {
        areaScore['ToolingInternal'] += confidence;
      }
      if (domainLower.includes('general')) {
        areaScore['GeneralProjectDoc'] += confidence * 0.5;
      }
    });

    // Score based on detected technologies
    context.dominantTech.forEach((tech) => {
      const techLower = tech.toLowerCase();
      if (techLower.includes('react') || techLower.includes('vue') || techLower.includes('angular')) {
        areaScore['Frontend'] += 0.3;
      }
      if (techLower.includes('node') || techLower.includes('express') || techLower.includes('django')) {
        areaScore['Backend'] += 0.3;
      }
      if (techLower.includes('postgres') || techLower.includes('mysql') || techLower.includes('mongodb')) {
        areaScore['Database'] += 0.3;
      }
      if (techLower.includes('docker') || techLower.includes('kubernetes') || techLower.includes('terraform')) {
        areaScore['DevOps'] += 0.3;
      }
      if (techLower.includes('jest') || techLower.includes('pytest') || techLower.includes('testing')) {
        areaScore['Testing'] += 0.3;
      }
    });

    // Apply path-based hints as additional scoring
    if (
      lowerDocPath.includes('/tools/') ||
      lowerDocPath.includes('/scripts/') ||
      lowerDocPath.includes('/cli/') ||
      lowerH1.includes(' cli') ||
      lowerH1.includes(' tool')
    ) {
      areaScore['ToolingInternal'] += 0.5;
    }
    if (
      lowerDocPath.includes('/api/') ||
      lowerDocPath.includes('/server/') ||
      lowerDocPath.includes('/db/') ||
      lowerDocPath.includes('/backend/') ||
      lowerH1.includes(' api') ||
      lowerH1.includes(' server') ||
      lowerH1.includes(' backend')
    ) {
      areaScore['Backend'] += 0.5;
    }
    if (
      lowerDocPath.includes('/frontend/') ||
      lowerDocPath.includes('/ui/') ||
      lowerDocPath.includes('/components/') ||
      lowerDocPath.includes('/views/') ||
      lowerDocPath.includes('/pages/') ||
      lowerH1.includes(' frontend') ||
      lowerH1.includes(' user interface')
    ) {
      areaScore['Frontend'] += 0.5;
    }
    if (
      lowerDocPath.endsWith('readme.md') ||
      lowerDocPath.endsWith('runbook.md') ||
      lowerDocPath.endsWith('contributing.md') ||
      lowerDocPath.endsWith('changelog.md')
    ) {
      areaScore['GeneralProjectDoc'] += 0.5;
    }

    // Find the area with the highest score
    let maxScore = 0;
    let selectedArea = 'Unknown';
    Object.entries(areaScore).forEach(([area, score]) => {
      if (score > maxScore) {
        maxScore = score;
        selectedArea = area;
      }
    });

    // Set threshold for area selection
    if (maxScore >= 0.4) {
      context.area = selectedArea;
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
      introduction: 1,
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
    if (context.area === 'ToolingInternal' && lowerDocPath.includes('readme') && readmeStylePoints >= 2) {
      context.isGeneralPurposeReadmeStyle = true;
    }

    // --- Extract Keywords ---
    // Add technologies as keywords
    context.keywords.push(...context.dominantTech.map((t) => t.toLowerCase()));

    // Extract keywords from H1
    if (lowerH1) {
      lowerH1
        .split(/[^a-z0-9-]+/g)
        .filter(
          (word) => word.length > 3 && !['the', 'for', 'and', 'with', 'into', 'about', 'using', 'docs', 'this', 'that'].includes(word)
        )
        .slice(0, 5)
        .forEach((kw) => context.keywords.push(kw));
    }

    // Add domain-based keywords
    classification.domains.slice(0, 3).forEach((domain) => {
      const words = domain.domain.toLowerCase().split(/[\s\-/]+/);
      words.forEach((word) => {
        if (word.length > 3 && !context.keywords.includes(word)) {
          context.keywords.push(word);
        }
      });
    });

    // Remove duplicates and limit
    context.keywords = [...new Set(context.keywords)].slice(0, 15);
  } catch (error) {
    console.error('Error in automatic zero-shot classification:', error);

    // Fallback to basic keyword extraction
    context.area = 'Unknown';
    context.dominantTech = [];

    // Extract basic keywords from text
    const words = fullTextForAnalysis.toLowerCase().split(/\s+/);
    const wordFreq = {};
    words.forEach((word) => {
      if (word.length > 4 && !['the', 'and', 'for', 'with', 'this', 'that', 'from', 'into'].includes(word)) {
        wordFreq[word] = (wordFreq[word] || 0) + 1;
      }
    });

    // Sort by frequency and take top keywords
    context.keywords = Object.entries(wordFreq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([word]) => word);
  }

  return context;
}
