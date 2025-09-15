/**
 * Project Architecture Analyzer
 *
 * Analyzes project structure during embedding generation to create comprehensive
 * project summaries that can be used as context during code reviews.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { getDefaultEmbeddingsSystem } from './embeddings/factory.js';
import * as llm from './llm.js';
import { isDocumentationFile, isTestFile } from './utils/file-validation.js';

export class ProjectAnalyzer {
  constructor() {
    this.llm = null;
    this.projectSummary = null;
    this.keyFiles = [];
    this.lastAnalysisHash = null;
  }

  /**
   * Analyze project structure and generate comprehensive summary
   */
  async analyzeProject(projectPath, options = {}) {
    const { verbose = false, forceAnalysis = false } = options;

    try {
      if (verbose) {
        console.log(chalk.cyan('🔍 Starting project architecture analysis...'));
      }

      // Initialize LLM client
      if (!this.llm) {
        this.llm = llm;
      }

      // Step 1: Try to load existing project analysis from database (unless forcing)
      const existingSummary = forceAnalysis ? null : await this.loadExistingAnalysis(projectPath);

      if (existingSummary && !forceAnalysis) {
        // Step 2: Check if key files have changed
        const currentHash = await this.calculateKeyFilesHash(existingSummary.keyFiles);

        if (existingSummary.keyFilesHash === currentHash) {
          if (verbose) {
            console.log(chalk.green('✅ Project analysis up-to-date (no key file changes detected)'));
          }
          return existingSummary;
        }

        if (verbose) {
          console.log(chalk.yellow('🔄 Key files changed, regenerating analysis...'));
        }
      } else {
        if (verbose) {
          if (forceAnalysis) {
            console.log(chalk.cyan('🔄 Force analysis requested - regenerating from scratch...'));
          } else {
            console.log(chalk.cyan('🆕 First-time analysis - discovering key files...'));
          }
        }
      }

      // Step 3: Discover or use existing key files
      const keyFiles = existingSummary
        ? await this.validateAndUpdateKeyFiles(existingSummary.keyFiles, projectPath)
        : await this.discoverKeyFilesWithLLM(projectPath);

      if (verbose) {
        console.log(chalk.gray(`   Found ${keyFiles.length} key architectural files`));
      }

      if (verbose) {
        console.log(chalk.cyan('🧠 Generating LLM-based project analysis...'));
      }

      // Step 4: Analyze key files with LLM
      const projectSummary = await this.generateProjectSummary(keyFiles, projectPath);

      // Step 5: Calculate hash for change detection and store results
      const currentHash = await this.calculateKeyFilesHash(keyFiles);
      projectSummary.keyFiles = keyFiles;
      projectSummary.keyFilesHash = currentHash;

      // Step 6: Store the updated analysis in the database
      await this.storeAnalysis(projectPath, projectSummary);

      this.projectSummary = projectSummary;
      this.keyFiles = keyFiles;
      this.lastAnalysisHash = currentHash;

      if (verbose) {
        console.log(chalk.green('✅ Project analysis complete'));
        console.log(chalk.gray(`   Technologies: ${projectSummary.technologies.join(', ')}`));
        console.log(chalk.gray(`   Key patterns: ${projectSummary.keyPatterns.length} identified`));
        console.log(chalk.gray(`   Key files tracked: ${keyFiles.length}`));
      }

      return projectSummary;
    } catch (error) {
      console.error(chalk.red('Error analyzing project:'), error.message);
      // Return a basic fallback summary
      return this.createFallbackSummary(projectPath);
    }
  }

  /**
   * Load existing project analysis from database
   */
  async loadExistingAnalysis(projectPath) {
    try {
      const embeddingsSystem = getDefaultEmbeddingsSystem();

      const summary = await embeddingsSystem.getProjectSummary(projectPath);

      if (summary && summary.keyFiles) {
        // Convert stored key files back to our format
        const keyFiles = summary.keyFiles.map((kf) => ({
          relativePath: kf.path,
          fullPath: path.join(projectPath, kf.path),
          category: kf.category,
          size: 0, // Will be updated when validated
          lastModified: new Date(kf.lastModified),
        }));

        return {
          ...summary,
          keyFiles: keyFiles,
        };
      }

      return null;
    } catch (error) {
      console.error(chalk.yellow('Warning: Could not load existing analysis:'), error.message);
      return null;
    }
  }

  /**
   * Store analysis results in database
   */
  async storeAnalysis(projectPath, projectSummary) {
    try {
      const embeddingsSystem = getDefaultEmbeddingsSystem();
      await embeddingsSystem.storeProjectSummary(projectPath, projectSummary);
      console.log(chalk.green('✅ Project analysis stored in database'));
    } catch (error) {
      console.error(chalk.yellow('Warning: Could not store analysis:'), error.message);
      // Continue execution even if storage fails
    }
  }

  /**
   * Validate and update existing key files list
   */
  async validateAndUpdateKeyFiles(existingKeyFiles, projectPath) {
    // Filter out files that no longer exist and convert to current format
    const validatedFiles = [];

    for (const keyFile of existingKeyFiles) {
      const fullPath = path.join(projectPath, keyFile.relativePath || keyFile.path);
      if (fs.existsSync(fullPath)) {
        const stats = fs.statSync(fullPath);
        validatedFiles.push({
          relativePath: keyFile.relativePath || keyFile.path,
          fullPath: fullPath,
          category: keyFile.category || 'unknown',
          size: stats.size,
          lastModified: stats.mtime,
        });
      }
    }

    // If we lost more than 30% of key files, trigger fresh discovery
    if (validatedFiles.length < existingKeyFiles.length * 0.7) {
      console.log(chalk.yellow('⚠️ Many key files missing, performing fresh discovery...'));
      return await this.discoverKeyFilesWithLLM(projectPath);
    }

    return validatedFiles;
  }

  /**
   * Discover key architectural files using LanceDB hybrid search
   */
  async discoverKeyFilesWithLLM(projectPath) {
    console.log(chalk.cyan('🔍 Mining codebase embeddings with LanceDB hybrid search...'));

    // Phase 1: Use LanceDB to find key files by category
    const keyFilesByCategory = await this.mineKeyFilesFromEmbeddings(projectPath);

    console.log(chalk.cyan(`🧠 LLM analyzing ${keyFilesByCategory.length} candidates from embedding search...`));

    // Phase 2: LLM selects final key files from search results
    const keyFiles = await this.selectFinalKeyFiles(keyFilesByCategory, projectPath);

    return keyFiles;
  }

  /**
   * Mine key files from embeddings database using hybrid search
   */
  async mineKeyFilesFromEmbeddings(projectPath) {
    const embeddingsSystem = getDefaultEmbeddingsSystem();
    await embeddingsSystem.initialize(); // Ensure system is initialized
    const db = await embeddingsSystem.databaseManager.getDB();
    const table = await db.openTable(embeddingsSystem.databaseManager.fileEmbeddingsTable);

    const keyFiles = new Map(); // Use Map to avoid duplicates

    try {
      console.log(chalk.gray(`   📊 Using LanceDB hybrid search for project: ${projectPath}`));
      // Helper function for proper hybrid queries using LanceDB API
      const hybridQuery = async (text, whereClause = null, limit = 30) => {
        try {
          let query = table.query().select(['path', 'name', 'content', 'type', 'language']);

          // Add full-text search if text provided
          if (text && text.trim()) {
            query = query.fullTextSearch(text);
          }

          // Try vector search with dimension validation
          try {
            const embedding = await embeddingsSystem.calculateQueryEmbedding(text || '');
            if (embedding && embedding.length > 0) {
              // Check if table schema supports vector search by examining vector dimensions
              const tableSchema = await table.schema;
              const vectorField = tableSchema.fields.find((f) => f.name === 'vector');

              if (vectorField) {
                // Check if dimensions match
                const expectedDims = vectorField.type.listSize;
                if (embedding.length === expectedDims) {
                  query = query.nearestTo(embedding);
                } else {
                  console.log(
                    chalk.yellow(`     ⚠️ Vector dimension mismatch: expected ${expectedDims}, got ${embedding.length}. Using FTS only.`)
                  );
                }
              }
            }
          } catch (embeddingError) {
            // Vector search not critical, continue with FTS only
            console.log(chalk.yellow(`     ⚠️ Vector search unavailable: ${embeddingError.message}`));
          }

          // Add where clause for project and additional filters
          const fullWhereClause = whereClause ? `project_path = '${projectPath}' AND (${whereClause})` : `project_path = '${projectPath}'`;
          query = query.where(fullWhereClause);

          // Execute query
          return await query.limit(limit).toArray();
        } catch (error) {
          console.log(chalk.yellow(`     ⚠️ Query failed for "${text}": ${error.message}`));

          // Fallback to simple where query if hybrid search fails
          try {
            console.log(chalk.yellow(`     🔄 Attempting fallback query...`));
            const fallbackQuery = table
              .query()
              .select(['path', 'name', 'content', 'type', 'language'])
              .where(whereClause ? `project_path = '${projectPath}' AND (${whereClause})` : `project_path = '${projectPath}'`)
              .limit(limit);
            return await fallbackQuery.toArray();
          } catch (fallbackError) {
            console.log(chalk.red(`     ❌ Fallback query also failed: ${fallbackError.message}`));
            return [];
          }
        }
      };
      // Check if we have any data for this project
      const sampleFiles = await hybridQuery('', null, 5);
      console.log(chalk.gray(`   📋 Found ${sampleFiles.length} sample files for project validation`));

      if (sampleFiles.length === 0) {
        console.log(chalk.yellow('⚠️ No files found in embeddings database for this project path'));
        return [];
      }
      // Ultra-simple query function that avoids all vector operations and FTS
      const simpleQuery = async (whereClause = null, limit = 30) => {
        try {
          let query = table.query().select(['path', 'name', 'content', 'type', 'language']);

          const fullWhereClause = whereClause ? `project_path = '${projectPath}' AND (${whereClause})` : `project_path = '${projectPath}'`;
          query = query.where(fullWhereClause);

          return await query.limit(limit).toArray();
        } catch (error) {
          console.log(chalk.yellow(`     ⚠️ Simple query failed: ${error.message}`));
          return [];
        }
      };

      // Content-based filtering function to replace FTS
      const filterByContent = (results, searchTerms) => {
        if (!searchTerms || !Array.isArray(searchTerms)) return results;

        return results.filter((result) => {
          const content = (result.content || '').toLowerCase();
          const path = (result.path || '').toLowerCase();
          const name = (result.name || '').toLowerCase();

          return searchTerms.some(
            (term) => content.includes(term.toLowerCase()) || path.includes(term.toLowerCase()) || name.includes(term.toLowerCase())
          );
        });
      };
      // A) Dependency & Package Management Files (generic) - Use simpler queries
      console.log(chalk.gray('   🔍 Searching for dependency files...'));

      // Use simple query + filtering to avoid FTS issues
      try {
        const allFiles = await simpleQuery(null, 100); // Get more files to filter from
        const depTerms = ['package.json', 'requirements.txt', 'gemfile', 'cargo.toml'];
        const depFileResults = filterByContent(allFiles, depTerms);

        depFileResults.forEach((result) => {
          if (this.isDependencyFile(result.path, result.name)) {
            keyFiles.set(result.path, { ...result, category: 'package', source: 'dep-simple' });
          }
        });
        console.log(chalk.gray(`   📦 Found ${depFileResults.length} dependency file candidates`));
      } catch (error) {
        console.log(chalk.yellow(`     ⚠️ Skipping dependency search: ${error.message}`));
      }

      // B) Configuration Files - Use simple query + filtering
      console.log(chalk.gray('   🔍 Searching for configuration files...'));
      try {
        const configTerms = ['config', 'dockerfile', 'makefile', 'eslint', 'prettier', 'jest'];
        const allFiles = await simpleQuery(null, 100);
        const configResults = filterByContent(allFiles, configTerms);

        configResults.forEach((result) => {
          if (this.isConfigFile(result.path, result.name)) {
            keyFiles.set(result.path, { ...result, category: 'config', source: 'config-simple' });
          }
        });
        console.log(chalk.gray(`   ⚙️ Found ${configResults.length} config file candidates`));
      } catch (error) {
        console.log(chalk.yellow(`     ⚠️ Skipping config search: ${error.message}`));
      }

      // C) Entry Points & Main Files - Use WHERE clause filtering
      console.log(chalk.gray('   🔍 Searching for entry points...'));
      try {
        const entryResults = await simpleQuery(
          "name LIKE '%index%' OR name LIKE '%main%' OR name LIKE '%app%' OR name LIKE '%server%'",
          20
        );

        entryResults.forEach((result) => {
          if (this.isEntryPointFile(result.path, result.name)) {
            keyFiles.set(result.path, { ...result, category: 'setup', source: 'entry-simple' });
          }
        });
        console.log(chalk.gray(`   🚪 Found ${entryResults.length} entry point candidates`));
      } catch (error) {
        console.log(chalk.yellow(`     ⚠️ Skipping entry search: ${error.message}`));
      }

      // D) Utilities & Common Patterns - Use simple query + filtering
      console.log(chalk.gray('   🔍 Searching for utility patterns...'));
      try {
        const utilityTerms = ['utils', 'services', 'components', 'helpers', 'common', 'lib'];
        const allFiles = await simpleQuery(null, 100);
        const utilityResults = filterByContent(allFiles, utilityTerms);

        utilityResults.forEach((result) => {
          if (this.isUtilityFile(result.path, result.name)) {
            keyFiles.set(result.path, { ...result, category: 'utility', source: 'util-simple' });
          }
        });
        console.log(chalk.gray(`   🛠️ Found ${utilityResults.length} utility file candidates`));
      } catch (error) {
        console.log(chalk.yellow(`     ⚠️ Skipping utility search: ${error.message}`));
      }

      // E) Documentation & README files - Use WHERE clause filtering
      console.log(chalk.gray('   🔍 Searching for documentation...'));
      try {
        const docResults = await simpleQuery("name LIKE '%README%' OR name LIKE '%CHANGELOG%' OR name LIKE '%.md'", 10);

        docResults.forEach((result) => {
          if (isDocumentationFile(result.path)) {
            keyFiles.set(result.path, { ...result, category: 'docs', source: 'doc-simple' });
          }
        });
        console.log(chalk.gray(`   📚 Found ${docResults.length} documentation file candidates`));
      } catch (error) {
        console.log(chalk.yellow(`     ⚠️ Skipping documentation search: ${error.message}`));
      }

      // F) Test Files - Use WHERE clause filtering
      console.log(chalk.gray('   🔍 Searching for test files...'));
      try {
        const testResults = await simpleQuery("name LIKE '%test%' OR name LIKE '%spec%' OR path LIKE '%test%' OR path LIKE '%spec%'", 15);

        testResults.forEach((result) => {
          if (isTestFile(result.path)) {
            keyFiles.set(result.path, { ...result, category: 'tests', source: 'test-simple' });
          }
        });
        console.log(chalk.gray(`   🧪 Found ${testResults.length} test file candidates`));
      } catch (error) {
        console.log(chalk.yellow(`     ⚠️ Skipping test search: ${error.message}`));
      }
    } catch (error) {
      console.error(chalk.red('Error mining embeddings:'), error.message);
      console.error(error.stack);
      return [];
    }

    const results = Array.from(keyFiles.values());
    console.log(chalk.cyan(`🗃️ Found ${results.length} key files from embeddings database`));

    return results;
  }

  /**
   * Helper methods for file classification
   */
  isConfigFile(filePath, fileName) {
    const configPatterns = [
      // Generic config files
      /\.config\.(js|ts|json|yaml|yml|toml|ini|conf)$/,
      /^dockerfile$/i,
      /^docker-compose\.(yml|yaml)$/,
      /^makefile$/i,
      /^cmake.*\.txt$/i,

      // JavaScript/TypeScript
      /^(webpack|vite|babel|rollup|prettier|eslint)\.config/,
      /^(tsconfig|jsconfig)\.json$/,
      /\.(eslintrc|prettierrc|babelrc)/,
      /^(jest|vitest|playwright)\.config/,

      // Python
      /^(setup|pyproject|tox|pytest)\.((py|toml|ini|cfg))$/,
      /^\.pylintrc$/,
      /^requirements.*\.txt$/,
      /^pipfile(\.lock)?$/i,

      // Java/JVM
      /^pom\.xml$/,
      /^build\.gradle(\.kts)?$/,
      /^gradle\.properties$/,
      /^settings\.gradle(\.kts)?$/,

      // Go
      /^go\.(mod|sum)$/,

      // Rust
      /^cargo\.(toml|lock)$/i,

      // Ruby
      /^gemfile(\.lock)?$/i,
      /^.*\.gemspec$/,

      // PHP
      /^composer\.(json|lock)$/,

      // C/C++
      /^cmakelists\.txt$/i,
      /^configure\.(ac|in)$/,
      /^conanfile\.(txt|py)$/,
      /^vcpkg\.json$/,
    ];

    return (
      configPatterns.some((pattern) => pattern.test(fileName.toLowerCase())) ||
      filePath.includes('.github/workflows/') ||
      filePath.includes('.vscode/') ||
      filePath.includes('.devcontainer/') ||
      fileName.toLowerCase().includes('config')
    );
  }

  isEntryPointFile(filePath, fileName) {
    const entryPatterns = [
      // JavaScript/TypeScript
      /^(index|main|app|server)\.(js|ts|jsx|tsx|mjs|cjs)$/,
      /^_app\.(js|ts|jsx|tsx)$/,
      /(router|routes|routing)\.(js|ts)$/,

      // Python
      /^(__main__|main|app|run|manage)\.py$/,

      // Java
      /^(main|application|app)\.java$/i,

      // Go
      /^main\.go$/,

      // Rust
      /^(main|lib)\.rs$/,

      // Ruby
      /^(main|app)\.rb$/,

      // PHP
      /^(index|app|main)\.php$/,

      // C/C++
      /^main\.(c|cpp|cc|cxx)$/,

      // Shell scripts
      /^(run|start|bootstrap)\.(sh|bash|zsh)$/,
    ];

    return (
      entryPatterns.some((pattern) => pattern.test(fileName.toLowerCase())) ||
      (fileName.toLowerCase().includes('index') && filePath.includes('src/')) ||
      (fileName.toLowerCase().includes('main') && filePath.includes('src/')) ||
      filePath.includes('/bin/') ||
      filePath.includes('/scripts/')
    );
  }

  isDependencyFile(filePath, fileName) {
    const depPatterns = [
      // JavaScript/Node.js
      /^package(-lock)?\.json$/,
      /^yarn\.lock$/,
      /^pnpm-lock\.yaml$/,

      // Python
      /^requirements.*\.txt$/,
      /^pipfile(\.lock)?$/i,
      /^pyproject\.toml$/,
      /^poetry\.lock$/,

      // Java/JVM
      /^pom\.xml$/,
      /^build\.gradle(\.kts)?$/,
      /^gradle\.lockfile$/,

      // Go
      /^go\.(mod|sum)$/,

      // Rust
      /^cargo\.(toml|lock)$/i,

      // Ruby
      /^gemfile(\.lock)?$/i,

      // PHP
      /^composer\.(json|lock)$/,

      // C/C++
      /^conanfile\.(txt|py)$/,
      /^vcpkg\.json$/,

      // Generic lock files
      /-lock\.(json|yaml|yml|toml)$/,
      /\.lock$/,
    ];
    return depPatterns.some((pattern) => pattern.test(fileName.toLowerCase()));
  }

  categorizeFrameworkFile(filePath, fileName, content) {
    // Generic categorization based on path and content
    if (this.isDependencyFile(filePath, fileName)) return 'package';
    if (this.isConfigFile(filePath, fileName)) return 'config';
    if (this.isEntryPointFile(filePath, fileName)) return 'setup';
    if (isTestFile(filePath)) return 'tests';
    if (isDocumentationFile(filePath)) return 'docs';
    if (this.isUtilityFile(filePath, fileName)) return 'utility';

    // Content-based detection for important patterns
    if (content) {
      const contentLower = content.toLowerCase();
      if (contentLower.includes('export') && contentLower.includes('function')) return 'utility';
      if (contentLower.includes('interface') || contentLower.includes('type ')) return 'types';
    }

    return null;
  }

  isUtilityFile(filePath, fileName) {
    const utilityPatterns = [
      /(util|utility|helper|service|api|hook|wrapper|component|store|state|common|shared|lib)/i,
      /(core|base|foundation|framework)/i,
      /(middleware|plugin|extension|adapter)/i,
    ];

    const utilityDirectories = [
      /src/,
      /lib/,
      /utils/,
      /helpers/,
      /services/,
      /common/,
      /shared/,
      /core/,
      /pkg/, // Go convention
      /internal/, // Go convention
    ];

    return (
      utilityPatterns.some((pattern) => pattern.test(fileName) || pattern.test(filePath)) &&
      utilityDirectories.some((pattern) => pattern.test(filePath)) &&
      !isTestFile(filePath) &&
      !isDocumentationFile(filePath)
    );
  }

  isTestConfig(filePath, fileName) {
    return (
      (fileName.includes('config') || fileName.includes('setup')) &&
      (fileName.includes('test') ||
        fileName.includes('jest') ||
        fileName.includes('vitest') ||
        fileName.includes('cypress') ||
        fileName.includes('playwright') ||
        filePath.includes('test'))
    );
  }

  /**
   * LLM selects final key files from search results
   */
  async selectFinalKeyFiles(candidates, projectPath) {
    if (candidates.length === 0) {
      console.log(chalk.yellow('⚠️ No candidates found from embeddings search'));
      return [];
    }

    console.log(chalk.cyan(`🤖 LLM analyzing ${candidates.length} candidates...`));

    // Create a concise summary of candidates for LLM
    const candidatesSummary = candidates
      .map((file, index) => {
        const snippet = file.content.substring(0, 150).replace(/\s+/g, ' ').trim();
        return `${index + 1}. ${file.path} (${file.category}): ${snippet}...`;
      })
      .join('\n');

    const prompt = `Analyze these ${candidates.length} file candidates and select the most architecturally important files (15-20 maximum).

Project: ${path.basename(projectPath)}

Files found by embeddings search:
${candidatesSummary}

Select files that best reveal the project's architecture:
- Framework setup & key configurations
- Custom utilities, hooks, and wrappers
- API/data layer patterns and GraphQL setup
- Type definitions & core interfaces
- Entry points, routing, and main structure
- State management and data flow patterns

IMPORTANT: Return ONLY a JSON array of file paths, nothing else:
["path1", "path2", "path3"]

Select files that define HOW this project works, especially custom implementations.`;

    try {
      const response = await this.llm.sendPromptToClaude(prompt, {
        temperature: 0.1,
        maxTokens: 1000,
      });

      console.log(chalk.gray('   📄 LLM Response preview:'), response.content.substring(0, 200));

      // Try multiple JSON extraction patterns
      let selectedPaths = null;

      // Pattern 1: Standard JSON array
      let jsonMatch = response.content.match(/\[[\s\S]*?\]/);
      if (jsonMatch) {
        try {
          selectedPaths = JSON.parse(jsonMatch[0]);
        } catch {
          console.log(chalk.yellow('   ⚠️ Failed to parse first JSON match'));
        }
      }

      // Pattern 2: Extract from code blocks
      if (!selectedPaths) {
        const codeBlockMatch = response.content.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/);
        if (codeBlockMatch) {
          try {
            selectedPaths = JSON.parse(codeBlockMatch[1]);
          } catch {
            console.log(chalk.yellow('   ⚠️ Failed to parse code block JSON'));
          }
        }
      }

      // Pattern 3: Look for any array-like structure
      if (!selectedPaths) {
        const arrayMatch = response.content.match(/\[[\s\S]*\]/);
        if (arrayMatch) {
          try {
            selectedPaths = JSON.parse(arrayMatch[0]);
          } catch {
            console.log(chalk.yellow('   ⚠️ Failed to parse array match'));
          }
        }
      }

      if (selectedPaths && Array.isArray(selectedPaths) && selectedPaths.length > 0) {
        // Convert back to full file objects with stats
        const keyFiles = [];
        for (const filePath of selectedPaths) {
          const candidate = candidates.find((f) => f.path === filePath);
          if (candidate) {
            const fullPath = path.join(projectPath, filePath);
            if (fs.existsSync(fullPath)) {
              const stats = fs.statSync(fullPath);
              keyFiles.push({
                relativePath: filePath,
                fullPath: fullPath,
                category: candidate.category,
                source: candidate.source,
                size: stats.size,
                lastModified: stats.mtime,
              });
            }
          }
        }

        console.log(chalk.cyan(`🎯 LLM selected ${keyFiles.length} final key files`));
        return keyFiles;
      } else {
        throw new Error(`Failed to extract valid JSON array from LLM response. Got: ${typeof selectedPaths}`);
      }
    } catch (error) {
      console.error(chalk.red('Error in LLM selection:'), error.message);
      console.log(chalk.yellow('   🔄 Falling back to automatic selection...'));

      // Enhanced fallback: return all candidates up to a reasonable limit
      const fallbackFiles = [];
      const categoryLimits = { package: 3, config: 6, setup: 4, utility: 4, types: 3, 'test-config': 2 };
      const categoryCounts = {};

      for (const candidate of candidates) {
        const category = candidate.category;
        const count = categoryCounts[category] || 0;
        const limit = categoryLimits[category] || 2;

        if (count < limit && fallbackFiles.length < 15) {
          const fullPath = path.join(projectPath, candidate.path);
          if (fs.existsSync(fullPath)) {
            const stats = fs.statSync(fullPath);
            fallbackFiles.push({
              relativePath: candidate.path,
              fullPath: fullPath,
              category: candidate.category,
              source: candidate.source,
              size: stats.size,
              lastModified: stats.mtime,
            });
            categoryCounts[category] = count + 1;
          }
        }
      }

      console.log(chalk.yellow(`⚠️ Used fallback selection: ${fallbackFiles.length} files`));
      return fallbackFiles;
    }
  }

  /**
   * Analyze key files using content sampling (token-efficient)
   */
  async analyzeKeyFilesWithContentSampling(candidates, projectPath) {
    // Read small content snippets from each candidate
    const fileSnippets = await this.extractContentSnippets(candidates, projectPath);

    // Create a compact prompt with just the essential information
    const prompt = `Analyze these file snippets and select the 15-25 most architecturally important files.

Project: ${path.basename(projectPath)}

Files with content previews:
${fileSnippets}

Select files that best reveal:
- Framework setup & configuration
- Custom utilities, hooks, wrappers
- API/data layer patterns
- Type definitions & interfaces
- Entry points & routing
- State management approach

Return JSON array of file paths: ["path1", "path2", ...]
Focus on files that define HOW this project works architecturally.`;

    try {
      const response = await this.llm.sendPromptToClaude(prompt, {
        temperature: 0.1,
        maxTokens: 1500,
      });

      const jsonMatch = response.content.match(/\[[\s\S]*?\]/);
      if (jsonMatch) {
        const selectedPaths = JSON.parse(jsonMatch[0]);

        // Convert back to full file objects
        const keyFiles = [];
        for (const filePath of selectedPaths) {
          const candidate = candidates.find((f) => f.path === filePath);
          if (candidate) {
            const fullPath = path.join(projectPath, filePath);
            const stats = fs.statSync(fullPath);
            keyFiles.push({
              relativePath: filePath,
              fullPath: fullPath,
              category: candidate.category,
              size: stats.size,
              lastModified: stats.mtime,
            });
          }
        }

        console.log(chalk.cyan(`🎯 LLM selected ${keyFiles.length} key files from content analysis`));
        return keyFiles;
      } else {
        throw new Error('Failed to parse LLM response');
      }
    } catch (error) {
      console.error(chalk.red('Error in content sampling analysis:'), error.message);
      // Fallback to top candidates from heuristic scoring
      return candidates.slice(0, 20).map((candidate) => {
        const fullPath = path.join(projectPath, candidate.path);
        const stats = fs.statSync(fullPath);
        return {
          relativePath: candidate.path,
          fullPath: fullPath,
          category: candidate.category,
          size: stats.size,
          lastModified: stats.mtime,
        };
      });
    }
  }

  /**
   * Extract small content snippets from files for LLM analysis
   */
  async extractContentSnippets(candidates, projectPath) {
    const snippets = [];
    const maxSnippetLength = 300; // Keep snippets small

    for (const candidate of candidates) {
      try {
        const fullPath = path.join(projectPath, candidate.path);
        const content = fs.readFileSync(fullPath, 'utf8');

        // Extract meaningful snippet
        let snippet = content.substring(0, maxSnippetLength);
        if (content.length > maxSnippetLength) {
          snippet += '...';
        }

        // Clean up snippet for better LLM understanding
        snippet = snippet
          .replace(/\s+/g, ' ') // Normalize whitespace
          .replace(/\/\*[\s\S]*?\*\//g, '') // Remove block comments
          .replace(/\/\/.*$/gm, '') // Remove line comments
          .trim();

        snippets.push(`${candidate.path}:\n${snippet}\n`);
      } catch {
        // Skip files that can't be read
        snippets.push(`${candidate.path}: [Unable to read file]\n`);
      }
    }

    return snippets.join('\n');
  }

  /**
   * Prepare file structure summary for LLM analysis
   */
  prepareFileStructureForLLM(allFiles) {
    // Group files by directory and type for better LLM understanding
    const grouped = {};

    allFiles.forEach((file) => {
      const dir = path.dirname(file.path);
      if (!grouped[dir]) {
        grouped[dir] = [];
      }
      grouped[dir].push(`${file.path} (${file.size}b, ${file.category})`);
    });

    // Format for LLM readability
    let structure = '';
    Object.keys(grouped)
      .sort()
      .forEach((dir) => {
        structure += `\n${dir}/:\n`;
        grouped[dir].forEach((file) => {
          structure += `  ${file}\n`;
        });
      });

    // Limit size to avoid overwhelming the LLM
    if (structure.length > 50000) {
      structure = structure.substring(0, 50000) + '\n... (truncated)';
    }

    return structure;
  }

  /**
   * Calculate hash of key files content to detect changes
   */
  async calculateKeyFilesHash(keyFiles) {
    const hash = crypto.createHash('sha256');

    for (const file of keyFiles) {
      try {
        const filePath = file.relativePath || file.path;
        const fullPath = file.fullPath || path.join(process.cwd(), filePath);

        // Include file path and last modified time in hash
        hash.update(filePath);

        if (file.lastModified) {
          hash.update(file.lastModified.toISOString ? file.lastModified.toISOString() : file.lastModified);
        }

        // For small files, include content snippet
        if (fs.existsSync(fullPath) && file.size < 50 * 1024) {
          // 50KB
          const content = fs.readFileSync(fullPath, 'utf8');
          hash.update(content.substring(0, 1000)); // First 1000 chars
        }
      } catch {
        // If we can't read the file, just include the path
        hash.update(file.relativePath || file.path || '');
      }
    }

    return hash.digest('hex');
  }

  /**
   * Generate comprehensive project summary using LLM analysis
   */
  async generateProjectSummary(keyFiles, projectPath) {
    // Prepare file contents for LLM analysis
    const fileContents = await this.extractFileContents(keyFiles);

    const prompt = `Analyze this project's architecture and provide a comprehensive summary. Here are the key files:

${fileContents}

Please analyze this project and provide a JSON response with:

{
  "projectName": "Project name from package.json or inferred",
  "projectType": "Type of project (web app, mobile app, library, etc.)",
  "mainFrameworks": ["Primary frameworks/libraries used"],
  "technologies": ["All technologies, languages, tools identified"],
  "architecturalPatterns": ["Patterns like MVC, component-based, microservices, etc."],
  "keyPatterns": [
    {
      "pattern": "Custom pattern name",
      "description": "How this pattern is implemented",
      "files": ["Relevant file paths"],
      "usage": "When and how it's used"
    }
  ],
  "customImplementations": [
    {
      "name": "Custom feature/hook/utility name",
      "description": "What it does and HOW it modifies standard library behavior",
      "files": ["Files where it's defined"],
      "properties": ["Key properties/methods it exposes, especially any that extend standard objects"],
      "usage": "How it should be used",
      "extendsStandard": "Which standard library/framework objects or APIs this modifies"
    }
  ],
  "apiPatterns": [
    {
      "type": "REST/GraphQL/etc",
      "description": "How APIs are structured",
      "patterns": ["URL patterns or query patterns"],
      "authentication": "Auth method if evident"
    }
  ],
  "stateManagement": {
    "approach": "Redux/Context/Zustand/etc or None",
    "patterns": ["How state is organized"],
    "files": ["Key state management files"]
  },
  "testingApproach": {
    "frameworks": ["Testing frameworks used"],
    "patterns": ["Testing patterns/conventions"],
    "coverage": ["What types of tests are emphasized"]
  },
  "codeStyle": {
    "conventions": ["Naming conventions, file organization, etc."],
    "linting": ["ESLint rules or other style enforcement"],
    "typescript": "Usage level if TypeScript project"
  },
  "deploymentInfo": {
    "platform": "Deployment platform if evident",
    "containerization": "Docker usage if present",
    "buildProcess": "Build tool and process"
  },
  "reviewGuidelines": [
    "Specific guidelines for code review based on this project's patterns",
    "What to look for in PRs",
    "Common patterns that should be maintained",
    "Potential issues specific to this architecture"
  ]
}

Focus on identifying patterns that would help in code review, especially:
- Custom utilities or modules that extend standard frameworks and libraries
- **CRITICAL: Custom properties or methods added to standard library objects** (e.g., custom properties on database query results, API responses, or framework objects)
- **Extensions to library APIs** - any way this project modifies or enhances standard library behavior
- Specific ways APIs are called and results are handled (look for non-standard patterns)
- Data flow and processing patterns
- Module organization and code structure patterns
- Type definitions and interfaces that define contracts, especially those that extend standard types
- Configuration patterns and environment handling
- **Custom wrappers** around standard libraries that add functionality

**CRITICAL ANALYSIS REQUIRED**: Look specifically for code that:
1. **Takes standard library return values and adds custom properties** - For example:
   - Functions that take query results and add success/loading/error properties
   - Wrappers that enhance API responses with additional metadata
   - Custom hooks that extend standard framework hooks with extra functionality
2. **Modifies or extends standard library interfaces** - Look for:
   - TypeScript interfaces that extend standard types with additional fields
   - Custom implementations that add methods to standard objects
   - Wrapper classes that enhance standard library functionality
3. **Creates custom versions of standard patterns** - Such as:
   - Custom error handling that adds properties to standard error objects
   - Middleware that modifies standard request/response patterns
   - Custom state management that extends standard patterns

**EXAMPLES TO RECOGNIZE**:
- If you see a function that takes a standard query result and returns an object with added success/error properties, identify this as a custom implementation
- If you see custom hooks that wrap standard library hooks and add properties, document these
- If you see type definitions that extend standard interfaces, note what properties they add

**OUTPUT REQUIREMENT**: For each custom implementation found, specifically identify what standard library object or pattern it extends in the "extendsStandard" field.

Be thorough but concise. This summary will be used to provide context during automated code reviews to prevent false positives about "non-standard" properties that are actually valid custom implementations in this project.`;

    try {
      const response = await this.llm.sendPromptToClaude(prompt, {
        temperature: 0.1, // Low temperature for consistency
        maxTokens: 4000,
      });

      // Parse the JSON response
      const jsonMatch = response.content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const summary = JSON.parse(jsonMatch[0]);

        // Add metadata
        summary.analysisDate = new Date().toISOString();
        summary.projectPath = projectPath;
        summary.keyFilesCount = keyFiles.length;

        return summary;
      } else {
        throw new Error('Failed to parse LLM response as JSON');
      }
    } catch (error) {
      console.error(chalk.red('Error generating project summary:'), error.message);
      return this.createFallbackSummary(projectPath, keyFiles);
    }
  }

  /**
   * Extract and format file contents for LLM analysis
   */
  async extractFileContents(keyFiles) {
    let content = '';

    // Limit total content size to avoid overwhelming the LLM
    let totalSize = 0;
    const maxTotalSize = 100 * 1024; // 100KB total

    for (const file of keyFiles.slice(0, 25)) {
      // Max 25 files
      if (totalSize >= maxTotalSize) break;

      try {
        const fileContent = fs.readFileSync(file.fullPath, 'utf8');
        const remainingSize = maxTotalSize - totalSize;
        const contentToAdd = fileContent.substring(0, Math.min(fileContent.length, remainingSize));

        content += `\n\n=== ${file.relativePath} (${file.category}) ===\n${contentToAdd}`;
        totalSize += contentToAdd.length;
      } catch (error) {
        content += `\n\n=== ${file.relativePath} (${file.category}) ===\n[Could not read file: ${error.message}]`;
      }
    }

    return content;
  }

  /**
   * Create a basic fallback summary when LLM analysis fails
   */
  createFallbackSummary(projectPath, keyFiles = []) {
    const packageJsonPath = path.join(projectPath, 'package.json');
    let projectName = path.basename(projectPath);
    let technologies = [];

    // Try to extract basic info from package.json
    if (fs.existsSync(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        projectName = packageJson.name || projectName;

        // Extract technologies from dependencies
        const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
        technologies = Object.keys(deps).slice(0, 10); // Top 10 dependencies
      } catch {
        // Continue with defaults
      }
    }

    return {
      projectName,
      projectType: 'Unknown',
      mainFrameworks: [],
      technologies,
      architecturalPatterns: [],
      keyPatterns: [],
      customImplementations: [],
      apiPatterns: [],
      stateManagement: { approach: 'Unknown', patterns: [], files: [] },
      testingApproach: { frameworks: [], patterns: [], coverage: [] },
      codeStyle: { conventions: [], linting: [], typescript: 'Unknown' },
      deploymentInfo: { platform: 'Unknown', containerization: false, buildProcess: 'Unknown' },
      reviewGuidelines: [
        'Follow established patterns in the codebase',
        'Maintain consistency with existing code style',
        'Ensure proper error handling',
        'Add appropriate tests for new functionality',
      ],
      analysisDate: new Date().toISOString(),
      projectPath,
      keyFilesCount: keyFiles.length,
      keyFiles: keyFiles.map((f) => ({
        path: f.relativePath,
        category: f.category,
        lastModified: f.lastModified?.toISOString() || new Date().toISOString(),
      })),
      fallback: true,
    };
  }
}
