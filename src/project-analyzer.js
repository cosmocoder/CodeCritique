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

// Consolidated file classification configuration
const FILE_PATTERNS = {
  config: {
    regexes: [
      /\.config\.(js|ts|json|yaml|yml|toml|ini|conf)$/,
      /^dockerfile$/i,
      /^docker-compose\.(yml|yaml)$/,
      /^makefile$/i,
      /^cmake.*\.txt$/i,
      /^(webpack|vite|babel|rollup|prettier|eslint)\.config/,
      /^(tsconfig|jsconfig)\.json$/,
      /\.(eslintrc|prettierrc|babelrc)/,
      /^(jest|vitest|playwright)\.config/,
      /^(setup|pyproject|tox|pytest)\.((py|toml|ini|cfg))$/,
      /^\.pylintrc$/,
      /^requirements.*\.txt$/,
      /^pipfile(\.lock)?$/i,
      /^pom\.xml$/,
      /^build\.gradle(\.kts)?$/,
      /^gradle\.properties$/,
      /^go\.(mod|sum)$/,
      /^cargo\.(toml|lock)$/i,
      /^gemfile(\.lock)?$/i,
      /^composer\.(json|lock)$/,
      /^cmakelists\.txt$/i,
      /^conanfile\.(txt|py)$/,
      /^vcpkg\.json$/,
    ],
    pathChecks: ['.github/workflows/', '.vscode/', '.devcontainer/'],
    keywords: ['config'],
  },

  entry: {
    regexes: [
      /^(index|main|app|server)\.(js|ts|jsx|tsx|mjs|cjs)$/,
      /^_app\.(js|ts|jsx|tsx)$/,
      /(router|routes|routing)\.(js|ts)$/,
      /^(__main__|main|app|run|manage)\.py$/,
      /^(main|application|app)\.java$/i,
      /^main\.go$/,
      /^(main|lib)\.rs$/,
      /^(main|app)\.rb$/,
      /^(index|app|main)\.php$/,
      /^main\.(c|cpp|cc|cxx)$/,
      /^(run|start|bootstrap)\.(sh|bash|zsh)$/,
    ],
    pathChecks: ['/bin/', '/scripts/'],
    keywords: ['index', 'main'],
  },

  dependency: {
    regexes: [
      /^package(-lock)?\.json$/,
      /^yarn\.lock$/,
      /^pnpm-lock\.yaml$/,
      /^requirements.*\.txt$/,
      /^pipfile(\.lock)?$/i,
      /^pyproject\.toml$/,
      /^poetry\.lock$/,
      /^pom\.xml$/,
      /^build\.gradle(\.kts)?$/,
      /^gradle\.lockfile$/,
      /^go\.(mod|sum)$/,
      /^cargo\.(toml|lock)$/i,
      /^gemfile(\.lock)?$/i,
      /^composer\.(json|lock)$/,
      /^conanfile\.(txt|py)$/,
      /^vcpkg\.json$/,
      /-lock\.(json|yaml|yml|toml)$/,
      /\.lock$/,
    ],
  },

  utility: {
    regexes: [
      /(util|utility|helper|service|api|hook|wrapper|component|store|state|common|shared|lib)/i,
      /(core|base|foundation|framework)/i,
      /(middleware|plugin|extension|adapter)/i,
      /(lazy|async|await|promise|retry|preload|loader|chunk|suspend)/i,
      /(context|provider|factory|builder|creator|generator|maker)/i,
      /(error|boundary|fallback|recovery)/i,
    ],
    pathChecks: ['/src/', '/lib/', '/utils/', '/helpers/', '/services/', '/common/', '/shared/', '/core/', '/pkg/', '/internal/'],
    excludePatterns: [isTestFile, isDocumentationFile],
  },

  types: {
    regexes: [
      /(types?|interface|model|schema|definition|contract)/i,
      /\.(d\.ts|types\.ts|interfaces\.ts|models\.ts)$/,
      /(graphql|gql|schema)/i,
    ],
    pathChecks: ['/src/', '/types/', '/models/', '/schemas/', '/lib/'],
    excludePatterns: [isTestFile, isDocumentationFile],
  },
};

// Database query configurations
const DB_SEARCH_CONFIGS = [
  { category: 'package', terms: ['package.json', 'requirements.txt', 'gemfile', 'cargo.toml'], limit: 30, matcher: 'dependency' },
  { category: 'config', terms: ['config', 'dockerfile', 'makefile', 'eslint', 'prettier', 'jest'], limit: 30, matcher: 'config' },
  {
    category: 'setup',
    whereClause: "name LIKE '%index%' OR name LIKE '%main%' OR name LIKE '%app%' OR name LIKE '%server%'",
    limit: 20,
    matcher: 'entry',
  },
  {
    category: 'utility',
    terms: ['utils', 'helpers', 'common', 'lib', 'hooks', 'wrapper', 'lazy', 'async', 'context', 'provider'],
    limit: 30,
    matcher: 'utility',
  },
  {
    category: 'frontend',
    terms: [
      'components',
      'lazy',
      'preload',
      'chunk',
      'route',
      'app',
      'wrapper',
      'async',
      'suspense',
      'react',
      'retry',
      'error',
      'boundary',
      'fallback',
      'maker',
    ],
    limit: 30,
    matcher: 'utility',
  },
  {
    category: 'backend',
    terms: ['services', 'api', 'graphql', 'resolver', 'schema', 'server', 'database', 'context', 'auth', 'middleware', 'validation'],
    limit: 30,
    matcher: 'utility',
  },
  { category: 'types', terms: ['types', 'interfaces', 'models', 'schema', 'definitions'], limit: 15, matcher: 'types' },
  { category: 'docs', whereClause: "name LIKE '%README%' OR name LIKE '%CHANGELOG%' OR name LIKE '%.md'", limit: 10, matcher: 'docs' },
  {
    category: 'tests',
    whereClause: "name LIKE '%test%' OR name LIKE '%spec%' OR path LIKE '%test%' OR path LIKE '%spec%'",
    limit: 15,
    matcher: 'tests',
  },
];

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

      // Check for existing analysis
      const existingSummary = forceAnalysis ? null : await this.loadExistingAnalysis(projectPath);
      if (existingSummary && !forceAnalysis) {
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
      } else if (verbose) {
        console.log(
          chalk.cyan(
            forceAnalysis
              ? '🔄 Force analysis requested - regenerating from scratch...'
              : '🆕 First-time analysis - discovering key files...'
          )
        );
      }

      // Discover or validate key files
      const keyFiles = existingSummary
        ? await this.validateAndUpdateKeyFiles(existingSummary.keyFiles, projectPath)
        : await this.discoverKeyFilesWithLLM(projectPath);

      if (verbose) {
        console.log(chalk.gray(`   Found ${keyFiles.length} key architectural files`));
        console.log(chalk.cyan('🧠 Generating LLM-based project analysis...'));
      }

      // Generate summary
      const projectSummary = await this.generateProjectSummary(keyFiles, projectPath);

      // Store results
      const currentHash = await this.calculateKeyFilesHash(keyFiles);
      projectSummary.keyFiles = keyFiles;
      projectSummary.keyFilesHash = currentHash;

      await this.storeAnalysis(projectPath, projectSummary);

      this.projectSummary = projectSummary;
      this.keyFiles = keyFiles;
      this.lastAnalysisHash = currentHash;

      if (verbose) {
        console.log(chalk.green('✅ Project analysis complete'));
        console.log(chalk.gray(`   Technologies: ${(projectSummary.technologies || []).join(', ')}`));
        console.log(chalk.gray(`   Key patterns: ${(projectSummary.keyPatterns || []).length} identified`));
        console.log(chalk.gray(`   Key files tracked: ${keyFiles.length}`));
      }

      return projectSummary;
    } catch (error) {
      console.error(chalk.red('Error analyzing project:'), error.message);
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
        const keyFiles = summary.keyFiles.map((kf) => ({
          relativePath: kf.path,
          fullPath: path.join(projectPath, kf.path),
          category: kf.category,
          size: 0,
          lastModified: new Date(kf.lastModified),
        }));
        return { ...summary, keyFiles };
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
    }
  }

  /**
   * Validate and update existing key files list
   */
  async validateAndUpdateKeyFiles(existingKeyFiles, projectPath) {
    const validatedFiles = [];

    for (const keyFile of existingKeyFiles) {
      const fullPath = path.join(projectPath, keyFile.relativePath || keyFile.path);
      if (fs.existsSync(fullPath)) {
        const stats = fs.statSync(fullPath);
        validatedFiles.push({
          relativePath: keyFile.relativePath || keyFile.path,
          fullPath,
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

    const keyFilesByCategory = await this.mineKeyFilesFromEmbeddings(projectPath);
    console.log(chalk.cyan(`🧠 LLM analyzing ${keyFilesByCategory.length} candidates from embedding search...`));

    const keyFiles = await this.selectFinalKeyFiles(keyFilesByCategory, projectPath);
    return keyFiles;
  }

  /**
   * Mine key files from embeddings database using unified search approach
   */
  async mineKeyFilesFromEmbeddings(projectPath) {
    const embeddingsSystem = getDefaultEmbeddingsSystem();
    await embeddingsSystem.initialize();
    const db = await embeddingsSystem.databaseManager.getDB();
    const table = await db.openTable(embeddingsSystem.databaseManager.fileEmbeddingsTable);

    const keyFiles = new Map();

    try {
      console.log(chalk.gray(`   📊 Using LanceDB hybrid search for project: ${projectPath}`));

      // Unified query function
      const queryFiles = async (config) => {
        try {
          let query = table.query().select(['path', 'name', 'content', 'type', 'language']);

          if (config.whereClause) {
            query = query.where(`project_path = '${projectPath}' AND (${config.whereClause})`);
          } else if (config.terms) {
            const allFiles = await table
              .query()
              .select(['path', 'name', 'content', 'type', 'language'])
              .where(`project_path = '${projectPath}'`)
              .limit(100)
              .toArray();

            return allFiles.filter((result) => {
              const content = (result.content || '').toLowerCase();
              const pathName = (result.path || '').toLowerCase();
              const name = (result.name || '').toLowerCase();
              return config.terms.some(
                (term) => content.includes(term.toLowerCase()) || pathName.includes(term.toLowerCase()) || name.includes(term.toLowerCase())
              );
            });
          } else {
            query = query.where(`project_path = '${projectPath}'`);
          }

          return await query.limit(config.limit || 30).toArray();
        } catch (error) {
          console.log(chalk.yellow(`     ⚠️ Query failed for ${config.category}: ${error.message}`));
          return [];
        }
      };

      // Execute all searches
      for (const config of DB_SEARCH_CONFIGS) {
        console.log(chalk.gray(`   🔍 Searching for ${config.category} files...`));

        const results = await queryFiles(config);
        console.log(chalk.gray(`   📦 Found ${results.length} ${config.category} file candidates`));

        results.forEach((result) => {
          if (this.matchesFileType(result.path, result.name, config.matcher, result.content)) {
            keyFiles.set(result.path, { ...result, category: config.category, source: `${config.category}-search` });
          }
        });
      }
    } catch (error) {
      console.error(chalk.red('Error mining embeddings:'), error.message);
      return [];
    }

    const results = Array.from(keyFiles.values());
    console.log(chalk.cyan(`🗃️ Found ${results.length} key files from embeddings database`));
    return results;
  }

  /**
   * Unified file type matching using consolidated patterns
   */
  matchesFileType(filePath, fileName, type) {
    if (type === 'docs') return isDocumentationFile(filePath);
    if (type === 'tests') return isTestFile(filePath);

    const config = FILE_PATTERNS[type];
    if (!config) return false;

    const fileNameLower = fileName.toLowerCase();
    const filePathLower = filePath.toLowerCase();

    // Check regex patterns
    const matchesRegex = config.regexes?.some((pattern) => pattern.test(fileNameLower));

    // Check path conditions
    const matchesPath = config.pathChecks?.some((pathCheck) => filePathLower.includes(pathCheck.toLowerCase()));

    // Check keywords
    const matchesKeywords = config.keywords?.some((keyword) => fileNameLower.includes(keyword) || filePathLower.includes(keyword));

    // Check exclusions
    const isExcluded = config.excludePatterns?.some((excludeFn) => excludeFn(filePath));

    return (matchesRegex || matchesPath || matchesKeywords) && !isExcluded;
  }

  /**
   * LLM selects final key files from search results with unified JSON parsing
   */
  async selectFinalKeyFiles(candidates, projectPath) {
    if (candidates.length === 0) {
      console.log(chalk.yellow('⚠️ No candidates found from embeddings search'));
      return [];
    }

    console.log(chalk.cyan(`🤖 LLM analyzing ${candidates.length} candidates...`));

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

      const selectedPaths = this.parseJsonFromResponse(response.content, true);

      if (selectedPaths && Array.isArray(selectedPaths) && selectedPaths.length > 0) {
        const keyFiles = selectedPaths
          .map((filePath) => {
            const candidate = candidates.find((f) => f.path === filePath);
            if (candidate) {
              const fullPath = path.join(projectPath, filePath);
              if (fs.existsSync(fullPath)) {
                const stats = fs.statSync(fullPath);
                return {
                  relativePath: filePath,
                  fullPath,
                  category: candidate.category,
                  source: candidate.source,
                  size: stats.size,
                  lastModified: stats.mtime,
                };
              }
            }
            return null;
          })
          .filter(Boolean);

        console.log(chalk.cyan(`🎯 LLM selected ${keyFiles.length} final key files`));
        return keyFiles;
      } else {
        throw new Error(`Failed to extract valid JSON array from LLM response`);
      }
    } catch (error) {
      console.error(chalk.red('Error in LLM selection:'), error.message);
      console.log(chalk.yellow('   🔄 Falling back to automatic selection...'));
      return this.fallbackFileSelection(candidates, projectPath);
    }
  }

  /**
   * Unified JSON parsing for LLM responses (handles both objects and arrays)
   */
  parseJsonFromResponse(content, expectArray = false) {
    const patterns = expectArray
      ? [
          /\[[\s\S]*?\]/, // Standard JSON array
          /```(?:json)?\s*(\[[\s\S]*?\])\s*```/, // Code block array
          /\[[\s\S]*\]/, // Any array-like structure
        ]
      : [
          /\{[\s\S]*\}/, // Standard JSON object
          /```(?:json)?\s*(\{[\s\S]*\})\s*```/, // Code block object
          /\[[\s\S]*?\]/, // Fallback to array
          /```(?:json)?\s*(\[[\s\S]*?\])\s*```/, // Code block array fallback
        ];

    for (const pattern of patterns) {
      const match = content.match(pattern);
      if (match) {
        try {
          const jsonStr = match[1] || match[0];
          return JSON.parse(jsonStr);
        } catch {
          continue;
        }
      }
    }
    return null;
  }

  /**
   * Enhanced fallback selection
   */
  fallbackFileSelection(candidates, projectPath) {
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
            fullPath,
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

  /**
   * Calculate hash of key files content to detect changes
   */
  async calculateKeyFilesHash(keyFiles) {
    const hash = crypto.createHash('sha256');

    for (const file of keyFiles) {
      try {
        const filePath = file.relativePath || file.path;
        const fullPath = file.fullPath || path.join(process.cwd(), filePath);

        hash.update(filePath);
        if (file.lastModified) {
          hash.update(file.lastModified.toISOString ? file.lastModified.toISOString() : file.lastModified);
        }

        // For small files, include content snippet
        if (fs.existsSync(fullPath) && file.size < 50 * 1024) {
          const content = fs.readFileSync(fullPath, 'utf8');
          hash.update(content.substring(0, 1000));
        }
      } catch {
        hash.update(file.relativePath || file.path || '');
      }
    }

    return hash.digest('hex');
  }

  /**
   * Generate comprehensive project summary using LLM analysis (SINGLE CALL)
   */
  async generateProjectSummary(keyFiles, projectPath) {
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
        temperature: 0.1,
        maxTokens: 4000,
      });

      const summary = this.parseJsonFromResponse(response.content, false);
      if (summary) {
        // Add metadata
        summary.analysisDate = new Date().toISOString();
        summary.projectPath = projectPath;
        summary.keyFilesCount = keyFiles.length;
        return summary;
      } else {
        console.error(chalk.red('Failed to parse LLM response as JSON'));
        console.error(chalk.gray('Response content preview:'), response.content.substring(0, 500));
        throw new Error('Failed to parse LLM response as JSON');
      }
    } catch (error) {
      console.error(chalk.red('Error generating project summary:'), error.message);
      const fallback = this.createFallbackSummary(projectPath, keyFiles);
      console.log(chalk.yellow('Using fallback summary with technologies:'), fallback.technologies);
      return fallback;
    }
  }

  /**
   * Extract and format file contents for LLM analysis
   */
  async extractFileContents(keyFiles) {
    let content = '';
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

    if (fs.existsSync(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        projectName = packageJson.name || projectName;
        const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
        technologies = Object.keys(deps).slice(0, 10);
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
