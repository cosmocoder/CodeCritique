/**
 * Open-ended Zero-Shot Classification Module
 *
 * This module provides zero-shot classification without predefined categories,
 * allowing it to detect any technology or framework mentioned in the text.
 */

import { execSync } from 'node:child_process';
import { env, pipeline } from '@huggingface/transformers';
import * as linguistLanguages from 'linguist-languages';
import { LRUCache } from 'lru-cache';
import stopwords from 'stopwords-iso/stopwords-iso.json' with { type: 'json' };
import techKeywords from './technology-keywords.json' with { type: 'json' };

// Configure Transformers.js environment
env.allowLocalModels = false;
env.useBrowserCache = false;

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
    this.isDisabled = false; // Separate flag for intentional disabling vs failed init

    // Common words to exclude from technology detection
    // Use English stopwords from stopwords-iso
    this.commonWords = new Set(stopwords.en || []);

    // Add additional technical context words that are too generic
    const additionalCommonWords = [
      'system',
      'modern',
      'architecture',
      'stack',
      'features',
      'data',
      'service',
      'tools',
      'runtime',
      'apps',
      'workloads',
      'pipeline',
      'builds',
      'team',
      'interfaces',
      'queries',
      'computing',
      'database',
      'processing',
      'stream',
      'analytics',
      'infrastructure',
      'runs',
      'orchestration',
      'mesh',
      'experimenting',
      'desktop',
      'entire',
      'reproducible',
      'migrating',
      'temporal',
      'distributed',
      'graph',
      'high-performance',
      'real-time',
      'reactive',
      'frontend',
      'instead',
      'legacy',
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
    ];

    // Add the additional words to the stopwords set
    additionalCommonWords.forEach((word) => this.commonWords.add(word));

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

  /**
   * Check if classifier is available and ready to use
   * @returns {boolean} True if classifier is available, false if disabled or not initialized
   */
  _ensureClassifierAvailable() {
    if (this.isDisabled) {
      return false; // Intentionally disabled on M1
    }

    if (!this.isInitialized || !this.classifier) {
      return false; // Not initialized or failed to initialize
    }

    return true;
  }

  async _doInitialize() {
    // Detect M1 chips specifically and disable classifiers completely due to mutex threading issues
    const isM1Chip = (() => {
      try {
        const cpuInfo = execSync('sysctl -n machdep.cpu.brand_string', { encoding: 'utf8' }).trim();
        return cpuInfo.includes('M1');
      } catch {
        return false;
      }
    })();

    if (isM1Chip) {
      console.log('⚠ Detected M1 chip - disabling HuggingFace zero-shot classifier due to mutex threading issues');
      this.classifier = null;
      this.isInitialized = false;
      this.isDisabled = true; // Clearly indicate this is intentionally disabled
      return;
    }

    try {
      console.log('Initializing open-ended zero-shot classifier...');

      this.classifier = await pipeline('zero-shot-classification', 'Xenova/mobilebert-uncased-mnli', {
        quantized: true,
        dtype: 'q4',
        device: 'cpu',
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
    for (const [, langData] of Object.entries(linguistLanguages)) {
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

    // Check if classifier is available (handles both disabled and failed initialization)
    if (!this._ensureClassifierAvailable()) {
      return [];
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

    // Check if classifier is available (handles both disabled and failed initialization)
    if (!this._ensureClassifierAvailable()) {
      return [];
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
