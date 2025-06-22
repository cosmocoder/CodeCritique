/**
 * Open-ended Zero-Shot Classification Module
 *
 * This module provides zero-shot classification without predefined categories,
 * allowing it to detect any technology or framework mentioned in the text.
 */

import * as linguistLanguages from 'linguist-languages';
import { env, pipeline } from '@huggingface/transformers';
import { fileURLToPath } from 'url';
import { LRUCache } from 'lru-cache';
import fs from 'fs';
import path from 'path';

// Configure Transformers.js environment
env.allowLocalModels = false;
env.useBrowserCache = false;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load technology keywords from JSON
const techKeywordsPath = path.join(__dirname, 'src', 'technology-keywords.json');
const techKeywords = JSON.parse(fs.readFileSync(techKeywordsPath, 'utf-8'));

/**
 * OpenZeroShotClassifier for unrestricted technology detection
 */
class OpenZeroShotClassifier {
  constructor() {
    this.classifier = null;
    this.initializationPromise = null;
    this.cache = new LRUCache({
      max: 100,
      ttl: 1000 * 60 * 60, // 1 hour TTL
    });
    this.isInitialized = false;

    // Common words to exclude from technology detection
    this.commonWords = new Set([
      'the',
      'this',
      'that',
      'with',
      'from',
      'into',
      'using',
      'building',
      'creating',
      'making',
      'developing',
      'writing',
      'implementing',
      'designing',
      'working',
      'getting',
      'setting',
      'running',
      'testing',
      'debugging',
      'deploying',
      'installing',
      'configuring',
      'managing',
      'maintaining',
      'updating',
      'for',
      'and',
      'but',
      'or',
      'nor',
      'yet',
      'so',
      'because',
      'since',
      'although',
      'though',
      'while',
      'when',
      'where',
      'how',
      'why',
      'what',
      'which',
      'who',
      'whom',
      'whose',
      'can',
      'could',
      'will',
      'would',
      'should',
      'must',
      'may',
      'might',
      'shall',
      'need',
      'want',
      'like',
      'use',
      'uses',
      'used',
      'make',
      'makes',
      'made',
      'get',
      'gets',
      'got',
      'have',
      'has',
      'had',
      'do',
      'does',
      'did',
      'be',
      'is',
      'are',
      'was',
      'were',
      'been',
      'being',
      'very',
      'really',
      'quite',
      'just',
      'only',
      'also',
      'too',
      'either',
      'neither',
      'both',
      'all',
      'some',
      'any',
      'many',
      'much',
      'few',
      'little',
      'more',
      'most',
      'less',
      'least',
      'good',
      'better',
      'best',
      'bad',
      'worse',
      'worst',
      'new',
      'old',
      'first',
      'last',
      'next',
      'previous',
      'current',
      'future',
      'past',
      'high',
      'low',
      'big',
      'small',
      'large',
      'tiny',
      'huge',
      'fast',
      'slow',
      'quick',
      'easy',
      'hard',
      'simple',
      'complex',
      'basic',
      'advanced',
      'beginner',
      'intermediate',
      'expert',
      'professional',
      'were',
      'our',
      'legacy',
      'system',
      'modern',
      'architecture',
      'stack',
      'high-performance',
      'real-time',
      'features',
      'reactive',
      'frontend',
      'data',
      'processing',
      'stream',
      'analytics',
      'infrastructure',
      'runs',
      'orchestration',
      'instead',
      'service',
      'mesh',
      'experimenting',
      'tools',
      'fast',
      'runtime',
      'desktop',
      'apps',
      'workloads',
      'entire',
      'pipeline',
      'reproducible',
      'builds',
      'migrating',
      'team',
      'interfaces',
      'queries',
      'temporal',
      'distributed',
      'computing',
      'database',
      'graph',
    ]);

    // Build technology patterns from loaded keywords
    this.techPatterns = this.buildTechPatterns();

    // Build a set of all known technologies for quick lookup
    this.knownTechnologies = this.buildKnownTechnologies();
  }

  /**
   * Initialize the zero-shot classification pipeline
   */
  async initialize() {
    if (this.isInitialized) return;

    if (!this.initializationPromise) {
      this.initializationPromise = this._doInitialize();
    }

    await this.initializationPromise;
  }

  async _doInitialize() {
    try {
      console.log('Initializing open-ended zero-shot classifier...');

      this.classifier = await pipeline('zero-shot-classification', 'Xenova/mobilebert-uncased-mnli', {
        quantized: true,
      });

      this.isInitialized = true;
      console.log('Open-ended zero-shot classifier initialized successfully');
    } catch (error) {
      console.error('Error initializing classifier:', error);
      this.isInitialized = false;
      throw error;
    }
  }

  /**
   * Build technology patterns from keywords JSON
   */
  buildTechPatterns() {
    const patterns = [
      /\b(\w+\.js)\b/gi, // Matches *.js frameworks
      /\b(\w+\.py)\b/gi, // Matches *.py libraries
      /\b([A-Z][a-zA-Z]+(?:[A-Z][a-zA-Z]+)*)\b/g, // CamelCase (React, FastAPI)
      /\b([a-z]+(?:-[a-z]+)+)\b/gi, // kebab-case (scikit-learn, styled-components)
    ];

    // Add dynamic patterns from linguist languages
    for (const [langName, langData] of Object.entries(linguistLanguages)) {
      if (langData.aliases) {
        langData.aliases.forEach((alias) => {
          patterns.push(new RegExp(`\\b${this.escapeRegex(alias)}\\b`, 'gi'));
        });
      }
    }

    return patterns;
  }

  /**
   * Build a set of all known technologies
   */
  buildKnownTechnologies() {
    const techs = new Set();

    // Add all technologies from JSON file
    const addTechsFromObject = (obj) => {
      for (const value of Object.values(obj)) {
        if (Array.isArray(value)) {
          value.forEach((tech) => techs.add(tech.toLowerCase()));
        } else if (typeof value === 'object') {
          addTechsFromObject(value);
        }
      }
    };

    addTechsFromObject(techKeywords);

    // Add languages from linguist
    for (const [langName, langData] of Object.entries(linguistLanguages)) {
      techs.add(langName.toLowerCase());
      if (langData.aliases) {
        langData.aliases.forEach((alias) => techs.add(alias.toLowerCase()));
      }
    }

    return techs;
  }

  /**
   * Escape regex special characters
   */
  escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Extract potential technology candidates from text
   */
  extractTechnologyCandidates(text) {
    const candidates = new Set();
    const lowerText = text.toLowerCase();

    // Look for known technologies
    for (const tech of this.knownTechnologies) {
      // Create regex for exact word boundary matching
      const regex = new RegExp(`\\b${this.escapeRegex(tech)}\\b`, 'i');
      if (regex.test(text)) {
        candidates.add(tech);
      }
    }

    // Extract using patterns
    for (const pattern of this.techPatterns) {
      const matches = text.matchAll(pattern);
      for (const match of matches) {
        const candidate = match[1] || match[0];
        if (candidate.length > 2 && candidate.length < 30 && !this.commonWords.has(candidate.toLowerCase())) {
          candidates.add(candidate);
        }
      }
    }

    // Extract capitalized words that might be technologies
    const sentences = text.split(/[.!?]+/);
    for (const sentence of sentences) {
      const words = sentence.trim().split(/\s+/);
      for (let i = 0; i < words.length; i++) {
        const word = words[i].replace(/[.,;:!?'"()[\]{}]/g, '');

        // Skip if it's a common word
        if (this.commonWords.has(word.toLowerCase())) continue;

        // Check if word is capitalized and not at sentence start
        if (i > 0 && /^[A-Z][a-zA-Z]+/.test(word) && word.length > 2 && word.length < 20) {
          candidates.add(word);
        }

        // Also check for acronyms
        if (/^[A-Z]{2,6}$/.test(word)) {
          candidates.add(word);
        }
      }
    }

    return Array.from(candidates);
  }

  /**
   * Classify if the text is about each candidate technology
   */
  async classifyTechnologies(text, minConfidence = 0.3) {
    if (!this.isInitialized) {
      await this.initialize();
    }

    const cacheKey = `tech:${text.substring(0, 100)}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    try {
      // Extract technology candidates
      const candidates = this.extractTechnologyCandidates(text);

      if (candidates.length === 0) {
        return [];
      }

      // Truncate text for classification
      const truncatedText = text.substring(0, 1000); // Reduced to avoid token limit errors

      // Create hypotheses for each candidate
      const hypotheses = candidates.map((tech) => `This text is about ${tech}`);

      // Classify
      const result = await this.classifier(truncatedText, hypotheses, {
        multi_label: true,
      });

      // Process results
      const classifications = [];
      for (let i = 0; i < result.labels.length; i++) {
        if (result.scores[i] >= minConfidence) {
          // Extract technology name from hypothesis
          const tech = result.labels[i].replace('This text is about ', '');
          classifications.push({
            technology: tech,
            confidence: result.scores[i],
          });
        }
      }

      // Sort by confidence
      classifications.sort((a, b) => b.confidence - a.confidence);

      this.cache.set(cacheKey, classifications);
      return classifications;
    } catch (error) {
      console.error('Error in technology classification:', error);
      return [];
    }
  }

  /**
   * Classify the general area/domain of the documentation
   */
  async classifyDomain(text, minConfidence = 0.3) {
    if (!this.isInitialized) {
      await this.initialize();
    }

    const cacheKey = `domain:${text.substring(0, 100)}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    try {
      const truncatedText = text.substring(0, 1000); // Reduced to avoid token limit errors

      // Open-ended domain hypotheses
      const domainHypotheses = [
        'This is frontend/UI documentation',
        'This is backend/server documentation',
        'This is database documentation',
        'This is DevOps/infrastructure documentation',
        'This is mobile app documentation',
        'This is data science/ML documentation',
        'This is API documentation',
        'This is security documentation',
        'This is testing documentation',
        'This is architecture documentation',
        'This is getting started/setup documentation',
        'This is configuration documentation',
        'This is deployment documentation',
        'This is troubleshooting documentation',
        'This is reference documentation',
        'This is tutorial documentation',
        'This is best practices documentation',
        'This is changelog/release notes',
      ];

      const result = await this.classifier(truncatedText, domainHypotheses, {
        multi_label: true,
      });

      // Process results
      const classifications = [];
      for (let i = 0; i < result.labels.length; i++) {
        if (result.scores[i] >= minConfidence) {
          classifications.push({
            domain: result.labels[i].replace('This is ', '').replace(' documentation', ''),
            confidence: result.scores[i],
          });
        }
      }

      // Sort by confidence
      classifications.sort((a, b) => b.confidence - a.confidence);

      this.cache.set(cacheKey, classifications);
      return classifications;
    } catch (error) {
      console.error('Error in domain classification:', error);
      return [];
    }
  }

  /**
   * Get a summary classification of the text
   */
  async classifyDocument(text) {
    const [technologies, domains] = await Promise.all([this.classifyTechnologies(text), this.classifyDomain(text)]);

    return {
      technologies,
      domains,
      primaryTechnology: technologies[0]?.technology || 'Unknown',
      primaryDomain: domains[0]?.domain || 'general',
    };
  }
}

// Export singleton instance
export const openClassifier = new OpenZeroShotClassifier();
