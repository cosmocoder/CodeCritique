/**
 * File Processor Module
 *
 * This module provides centralized file processing capabilities for embeddings.
 * It handles batch processing, directory structure generation, and progress tracking.
 *
 * Features:
 * - Batch file processing with progress tracking
 * - Directory structure generation and embedding
 * - File filtering and exclusion logic
 * - Document chunk processing
 * - Vector index creation
 * - Comprehensive error handling
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import { isDocumentationFile, shouldProcessFile as utilsShouldProcessFile, batchCheckGitignore } from '../utils/file-validation.js';
import { detectLanguageFromExtension } from '../utils/language-detection.js';
import { debug, verboseLog } from '../utils/logging.js';
import { extractMarkdownChunks } from '../utils/markdown.js';
import { escapeSqlString, slugify } from '../utils/string-utils.js';
import { TABLE_NAMES, LANCEDB_DIR_NAME, FASTEMBED_CACHE_DIR_NAME } from './constants.js';
import { createFileProcessingError } from './errors.js';

const FILE_EMBEDDING_BATCH_SIZE = 50;
const DIRECTORY_STRUCTURE_TYPE = 'directory-structure';

function createShortHash(content) {
  return createHash('md5').update(content).digest('hex').substring(0, 8);
}

function createProjectStructureId(projectPath) {
  return `__project_structure__#${createShortHash(path.resolve(projectPath))}`;
}

function buildDocumentChunkId(originalDocumentPath, heading, startLineInDoc) {
  return `${originalDocumentPath}#${slugify(heading || 'section')}_${startLineInDoc}`;
}

function buildExistingDocumentSignature(chunks) {
  return chunks
    .map((chunk) => `${chunk.id}:${chunk.content_hash}`)
    .sort()
    .join('|');
}

// ============================================================================
// FILE PROCESSOR CLASS
// ============================================================================

export class FileProcessor {
  constructor(options = {}) {
    this.modelManager = options.modelManager || null;
    this.databaseManager = options.databaseManager || null;
    this.cacheManager = options.cacheManager || null;

    // Processing state
    this.processedFiles = new Map();
    this.cleaningUp = false;
    this.progressTracker = {
      totalFiles: 0,
      processedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      startTime: 0,
      reset(total) {
        this.totalFiles = total;
        this.processedCount = 0;
        this.skippedCount = 0;
        this.failedCount = 0;
        this.startTime = Date.now();
      },
      update(type) {
        if (type === 'processed') this.processedCount++;
        if (type === 'skipped') this.skippedCount++;
        if (type === 'failed') this.failedCount++;
        // Progress logging is now handled by the spinner in index.js via onProgress callback
      },
    };

    // Table names
    this.fileEmbeddingsTable = TABLE_NAMES.FILE_EMBEDDINGS;
    this.documentChunkTable = TABLE_NAMES.DOCUMENT_CHUNK;
  }

  // ============================================================================
  // PROGRESS TRACKING
  // ============================================================================

  /**
   * Get progress tracker
   * @returns {Object} Progress tracker object
   */
  getProgressTracker() {
    return this.progressTracker;
  }

  /**
   * Reset progress tracker
   * @param {number} totalFiles - Total number of files to process
   */
  resetProgressTracker(totalFiles = 0) {
    this.progressTracker.reset(totalFiles);
  }

  // ============================================================================
  // DIRECTORY STRUCTURE PROCESSING
  // ============================================================================

  /**
   * Generate directory structure string
   * @param {Object} options - Options for generating directory structure
   * @returns {string} Directory structure as a string
   */
  generateDirectoryStructure(options = {}) {
    const { rootDir = process.cwd(), maxDepth = 5, ignorePatterns = [], showFiles = true } = options;
    debug(`Generating directory structure: rootDir=${rootDir}, maxDepth=${maxDepth}, showFiles=${showFiles}`);

    // Use path.sep for platform compatibility
    const pathSep = path.sep;
    // More robust ignore pattern matching (handles directory separators)
    const shouldIgnore = (relPath) =>
      ignorePatterns.some((pattern) => {
        const normalizedPattern = pattern.replace(/\//g, pathSep); // Normalize pattern separators
        const normalizedPath = relPath.replace(/\//g, pathSep);
        if (normalizedPattern.startsWith(`**${pathSep}`)) {
          return normalizedPath.includes(normalizedPattern.slice(3));
        }
        return normalizedPath.includes(normalizedPattern);
      });

    const buildStructure = (dir, depth = 0, prefix = '') => {
      if (depth > maxDepth) return '';
      let result = '';
      try {
        const entries = fs
          .readdirSync(dir, { withFileTypes: true })
          .sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i];
          const isLast = i === entries.length - 1;
          const entryPath = path.join(dir, entry.name);
          const relativePath = path.relative(rootDir, entryPath);
          // Skip if ignored
          if (shouldIgnore(relativePath) || entry.name === LANCEDB_DIR_NAME || entry.name === FASTEMBED_CACHE_DIR_NAME) continue; // Also ignore DB/cache dirs

          const connector = isLast ? '└── ' : '├── ';
          const nextPrefix = isLast ? prefix + '    ' : prefix + '│   ';
          if (entry.isDirectory()) {
            result += `${prefix}${connector}${entry.name}/\n`;
            result += buildStructure(entryPath, depth + 1, nextPrefix);
          } else if (showFiles) {
            result += `${prefix}${connector}${entry.name}\n`;
          }
        }
      } catch (error) {
        console.error(`Error reading directory ${dir}:`, error.message);
      }
      return result;
    };
    return buildStructure(rootDir);
  }

  /**
   * Generate and store an embedding for the project directory structure
   * @param {Object} options - Options for generating the directory structure
   * @returns {Promise<boolean>} True if successful, false otherwise
   */
  async generateDirectoryStructureEmbedding(options = {}) {
    verboseLog(options, chalk.cyan('[generateDirEmb] Starting...')); // Log entry

    if (!this.modelManager) {
      throw createFileProcessingError('ModelManager is required for directory structure embedding');
    }

    if (!this.databaseManager) {
      throw createFileProcessingError('DatabaseManager is required for directory structure embedding');
    }

    try {
      await this.databaseManager.getDB();
      const table = await this.databaseManager.getTable(this.fileEmbeddingsTable);
      if (!table) {
        throw new Error(`[generateDirEmb] Table ${this.fileEmbeddingsTable} not found.`);
      }

      const rootDir = options.rootDir || process.cwd();
      const projectName = path.basename(path.resolve(rootDir));
      const resolvedRootDir = path.resolve(rootDir);
      const structureId = createProjectStructureId(resolvedRootDir);

      const directoryStructure = this.generateDirectoryStructure(options);
      if (!directoryStructure) throw new Error('[generateDirEmb] Failed to generate directory structure string');
      debug('[generateDirEmb] Directory structure string generated.');

      const directoryStructureHash = createShortHash(directoryStructure);
      let existingStructureRecords = [];
      try {
        existingStructureRecords = await table
          .query()
          .where(`project_path = '${escapeSqlString(resolvedRootDir)}' AND type = '${DIRECTORY_STRUCTURE_TYPE}'`)
          .toArray();
      } catch (queryError) {
        debug(`[generateDirEmb] Could not query existing project structure embeddings: ${queryError.message}`);
      }

      const matchingStructure = existingStructureRecords.find((record) => record.content_hash === directoryStructureHash);
      if (matchingStructure) {
        debug('[generateDirEmb] Directory structure unchanged, skipping regeneration.');
        return true;
      }

      for (const existingRecord of existingStructureRecords) {
        try {
          await table.delete(`id = '${escapeSqlString(existingRecord.id)}'`);
          debug(`[generateDirEmb] Deleted stale project structure embedding: ${existingRecord.id}`);
        } catch (error) {
          if (!error.message.includes('Record not found') && !error.message.includes('cannot find')) {
            debug(`[generateDirEmb] Error deleting existing project structure: ${error.message}`);
          }
        }
      }

      // *** Calculate embedding explicitly ***
      const embedding = await this.modelManager.calculateEmbedding(directoryStructure);

      if (!embedding) {
        console.error(chalk.red('[generateDirEmb] Failed to calculate embedding for directory structure.'));
        return false; // Indicate failure
      }
      debug(`[generateDirEmb] Embedding calculated, length: ${embedding.length}`);

      const record = {
        vector: embedding, // Include calculated embedding
        id: structureId,
        content: directoryStructure,
        type: DIRECTORY_STRUCTURE_TYPE,
        name: `${projectName} Project Structure`,
        path: `${projectName} Project Structure`,
        project_path: resolvedRootDir,
        language: 'text',
        content_hash: directoryStructureHash,
        last_modified: new Date().toISOString(),
      };

      debug(`[generateDirEmb] Prepared record: ID=${record.id}, Vector length=${record.vector?.length}`);
      if (record.vector?.length !== this.modelManager.embeddingDimensions) {
        console.error(chalk.red(`[generateDirEmb] !!! Vector dimension mismatch before add !!!`));
        return false; // Don't add invalid record
      }

      // *** Add record with specific try/catch ***
      debug('[generateDirEmb] Attempting table.add...');
      try {
        await table.add([record]);
        verboseLog(options, chalk.green('[generateDirEmb] Successfully added directory structure embedding.'));
        return true; // Indicate success
      } catch (addError) {
        console.error(chalk.red(`[generateDirEmb] !!! Error during table.add: ${addError.message}`), addError.stack);
        return false; // Indicate failure
      }
    } catch (error) {
      console.error(chalk.red(`[generateDirEmb] Overall error: ${error.message}`), error.stack);
      return false; // Indicate failure
    }
  }

  // ============================================================================
  // BATCH PROCESSING
  // ============================================================================

  /**
   * Process embeddings for multiple files in batch
   * @param {string[]} filePaths - Array of file paths to process
   * @param {Object} options - Processing options
   * @returns {Promise<Object>} Processing results
   */
  async processBatchEmbeddings(filePaths, options = {}) {
    const {
      excludePatterns = [],
      respectGitignore = true,
      baseDir: optionBaseDir = process.cwd(),
      maxLines = 1000,
      batchSize = FILE_EMBEDDING_BATCH_SIZE,
      onProgress,
      runMode = 'full',
    } = options;
    const resolvedCanonicalBaseDir = path.resolve(optionBaseDir);
    debug(`Resolved canonical base directory: ${resolvedCanonicalBaseDir}`);

    if (!this.modelManager) {
      throw createFileProcessingError('ModelManager is required for batch processing');
    }

    if (!this.databaseManager) {
      throw createFileProcessingError('DatabaseManager is required for batch processing');
    }

    try {
      await this.modelManager.initialize(); // Ensure model is ready
    } catch {
      console.error(chalk.red('Failed to initialize embedding model. Aborting batch process.'));
      return { processed: 0, failed: filePaths.length, skipped: 0, excluded: 0, files: [], failedFiles: [...filePaths], excludedFiles: [] };
    }

    verboseLog(options, chalk.blue('Ensuring database tables exist before batch processing...'));
    try {
      await this.databaseManager.getDB();
      verboseLog(options, chalk.green('Database table check complete.'));
    } catch (dbError) {
      console.error(chalk.red(`Failed to initialize database or tables: ${dbError.message}. Aborting batch process.`));
      return { processed: 0, failed: filePaths.length, skipped: 0, excluded: 0, files: [], failedFiles: [...filePaths], excludedFiles: [] };
    }

    const results = { processed: 0, failed: 0, skipped: 0, excluded: 0, files: [], failedFiles: [], excludedFiles: [] };
    const exclusionOptions = { excludePatterns, respectGitignore, baseDir: resolvedCanonicalBaseDir };
    this.processedFiles.clear();
    this.progressTracker.reset(filePaths.length);
    verboseLog(options, chalk.blue(`Starting batch processing of ${filePaths.length} files...`));

    const sharedState = await this._createSharedProcessingState(filePaths, resolvedCanonicalBaseDir, exclusionOptions, options);

    // Generate directory structure embedding first
    try {
      await this.generateDirectoryStructureEmbedding({
        rootDir: resolvedCanonicalBaseDir,
        maxDepth: 5,
        ignorePatterns: excludePatterns,
        showFiles: true,
        verbose: options.verbose,
      });
    } catch (structureError) {
      console.warn(chalk.yellow(`Warning: Failed to generate directory structure embedding: ${structureError.message}`));
    }

    if (!sharedState.fileTable) {
      console.error(chalk.red(`Table ${this.fileEmbeddingsTable} not found. Aborting batch file embedding.`));
      results.failed = filePaths.length;
      results.failedFiles = [...filePaths];
      this.progressTracker.failedCount = filePaths.length;
      this.progressTracker.update('failed');
      return results;
    }

    const candidates = await this._prepareCandidateFiles(filePaths, exclusionOptions, sharedState, results, onProgress);

    verboseLog(options, chalk.cyan('--- Starting Phase 1: File Embeddings ---'));
    await this._processFileEmbeddings(candidates, sharedState, {
      batchSize,
      maxLines,
      onProgress,
      results,
      verbose: options.verbose,
    });

    // Process document chunks
    await this._processDocumentChunks(candidates, sharedState, options.verbose);

    if (runMode === 'full') {
      await this._pruneStaleEmbeddings(sharedState, options.verbose);
    }

    verboseLog(options, chalk.green(`Batch processing complete!`));

    // Update progress tracker counts for internal tracking
    this.progressTracker.processedCount = results.processed;
    this.progressTracker.skippedCount = results.excluded + results.skipped;
    this.progressTracker.failedCount = results.failed;

    return results;
  }

  // ============================================================================
  // PRIVATE METHODS
  // ============================================================================

  /**
   * Process a batch of files
   * @param {string[]} filePaths - File paths to process
   * @param {string} baseDir - Base directory
   * @param {Object} exclusionOptions - Exclusion options
   * @param {Function} onProgress - Progress callback
   * @returns {Promise<Object>} Batch processing results
   * @private
   */
  async _createSharedProcessingState(filePaths, baseDir, exclusionOptions, options = {}) {
    const absoluteFilePaths = filePaths.map((filePath) =>
      path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(baseDir, filePath)
    );
    const gitignoreCache =
      exclusionOptions.respectGitignore !== false
        ? await batchCheckGitignore(absoluteFilePaths, baseDir, { verbose: options.verbose })
        : new Map();

    const fileTable = await this.databaseManager.getTable(this.fileEmbeddingsTable);
    const documentChunkTable = await this.databaseManager.getTable(this.documentChunkTable);
    const existingFilesMap = new Map();
    const existingDocChunksMap = new Map();
    const escapedBaseDir = escapeSqlString(baseDir);

    if (fileTable) {
      try {
        const existingRecords = await fileTable.query().where(`project_path = '${escapedBaseDir}'`).toArray();
        for (const record of existingRecords) {
          if (!existingFilesMap.has(record.path)) {
            existingFilesMap.set(record.path, []);
          }
          existingFilesMap.get(record.path).push(record);
        }
        verboseLog(options, chalk.cyan(`Found ${existingRecords.length} existing file embeddings for comparison`));
      } catch (queryError) {
        console.warn(chalk.yellow(`Warning: Could not query existing embeddings: ${queryError.message}`));
      }
    }

    if (documentChunkTable) {
      try {
        const existingChunks = await documentChunkTable.query().where(`project_path = '${escapedBaseDir}'`).toArray();
        for (const chunk of existingChunks) {
          if (!existingDocChunksMap.has(chunk.original_document_path)) {
            existingDocChunksMap.set(chunk.original_document_path, []);
          }
          existingDocChunksMap.get(chunk.original_document_path).push(chunk);
        }
        verboseLog(options, chalk.cyan(`Found ${existingChunks.length} existing document chunks for comparison`));
      } catch (queryError) {
        console.warn(chalk.yellow(`Warning: Could not query existing document chunks: ${queryError.message}`));
      }
    }

    return {
      baseDir,
      fileTable,
      documentChunkTable,
      gitignoreCache,
      existingFilesMap,
      existingDocChunksMap,
      liveFilePaths: new Set(),
      liveDocumentPaths: new Set(),
    };
  }

  async _prepareCandidateFiles(filePaths, exclusionOptions, sharedState, results, onProgress) {
    const candidates = [];

    for (const filePath of filePaths) {
      const absoluteFilePath = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(sharedState.baseDir, filePath);
      const relativePath = path.relative(sharedState.baseDir, absoluteFilePath);

      try {
        const stats = fs.statSync(absoluteFilePath);
        const language = detectLanguageFromExtension(path.extname(absoluteFilePath));

        if (
          !utilsShouldProcessFile(absoluteFilePath, '', {
            ...exclusionOptions,
            baseDir: sharedState.baseDir,
            relativePathToCheck: relativePath,
            gitignoreCache: sharedState.gitignoreCache,
            fileStats: stats,
          })
        ) {
          results.excluded++;
          results.excludedFiles.push(filePath);
          this.progressTracker.update('skipped');
          if (typeof onProgress === 'function') onProgress('excluded', filePath);
          this.processedFiles.set(filePath, 'excluded');
          continue;
        }

        candidates.push({
          filePath: absoluteFilePath,
          originalInputPath: filePath,
          relativePath,
          stats,
          language,
          isDocumentation: isDocumentationFile(absoluteFilePath, language),
          existingRecords: sharedState.existingFilesMap.get(relativePath) || [],
        });
      } catch {
        results.failed++;
        results.failedFiles.push(filePath);
        this.progressTracker.update('failed');
        if (typeof onProgress === 'function') onProgress('failed', filePath);
        this.processedFiles.set(filePath, 'failed_stat');
      }
    }

    return candidates;
  }

  async _processFileEmbeddings(candidates, sharedState, options = {}) {
    const { batchSize = FILE_EMBEDDING_BATCH_SIZE, maxLines = 1000, onProgress, results, verbose = false } = options;

    for (let start = 0; start < candidates.length; start += batchSize) {
      const batch = candidates.slice(start, start + batchSize);
      const filesToActuallyProcess = [];
      const contentsToActuallyProcess = [];
      const recordsToDelete = new Map();

      for (const candidate of batch) {
        try {
          const rawContent = await fs.promises.readFile(candidate.filePath, 'utf8');
          candidate.fullContent = rawContent;

          if (rawContent.trim().length === 0) {
            results.skipped++;
            this.progressTracker.update('skipped');
            if (typeof onProgress === 'function') onProgress('skipped', candidate.originalInputPath);
            this.processedFiles.set(candidate.originalInputPath, 'skipped_empty');
            continue;
          }

          let embeddingContent = rawContent;
          if (!candidate.isDocumentation) {
            const lines = rawContent.split('\n');
            if (lines.length > maxLines) {
              embeddingContent = lines.slice(0, maxLines).join('\n') + `\n... (truncated from ${lines.length} lines)`;
              debug(`Truncated code file ${candidate.relativePath} from ${lines.length} lines to ${maxLines} lines`);
            }
          }

          candidate.embeddingContent = embeddingContent;
          candidate.contentHash = createShortHash(embeddingContent);
          sharedState.liveFilePaths.add(candidate.relativePath);

          const unchangedRecord = candidate.existingRecords.find((record) => record.content_hash === candidate.contentHash);
          if (unchangedRecord) {
            results.skipped++;
            this.progressTracker.update('skipped');
            if (typeof onProgress === 'function') onProgress('skipped', candidate.originalInputPath);
            this.processedFiles.set(candidate.originalInputPath, 'skipped_unchanged');
            debug(`Skipping unchanged file: ${candidate.relativePath} (hash: ${candidate.contentHash})`);
            continue;
          }

          for (const existingRecord of candidate.existingRecords) {
            recordsToDelete.set(existingRecord.id, existingRecord);
          }

          filesToActuallyProcess.push(candidate);
          contentsToActuallyProcess.push(candidate.embeddingContent);
        } catch {
          candidate.readError = true;
          results.failed++;
          results.failedFiles.push(candidate.originalInputPath);
          this.progressTracker.update('failed');
          if (typeof onProgress === 'function') onProgress('failed', candidate.originalInputPath);
          this.processedFiles.set(candidate.originalInputPath, 'failed_read');
        }
      }

      for (const recordToDelete of recordsToDelete.values()) {
        try {
          await sharedState.fileTable.delete(`id = '${escapeSqlString(recordToDelete.id)}'`);
          debug(`Deleted old version: ${recordToDelete.path} (old hash: ${recordToDelete.content_hash})`);
        } catch (deleteError) {
          console.warn(chalk.yellow(`Warning: Could not delete old version of ${recordToDelete.path}: ${deleteError.message}`));
        }
      }

      if (filesToActuallyProcess.length === 0) {
        continue;
      }

      verboseLog(
        { verbose },
        chalk.cyan(
          `Processing ${filesToActuallyProcess.length} new/changed files in batch (${Math.min(start + batch.length, candidates.length)}/${candidates.length})`
        )
      );

      try {
        const embeddings = await this.modelManager.calculateEmbeddingBatch(contentsToActuallyProcess);
        const recordsToAdd = [];

        for (let i = 0; i < embeddings.length; i++) {
          const candidate = filesToActuallyProcess[i];
          const embeddingVector = embeddings[i];

          if (!embeddingVector) {
            results.failed++;
            results.failedFiles.push(candidate.originalInputPath);
            this.progressTracker.update('failed');
            if (typeof onProgress === 'function') onProgress('failed', candidate.originalInputPath);
            this.processedFiles.set(candidate.originalInputPath, 'failed_embedding');
            continue;
          }

          recordsToAdd.push({
            vector: embeddingVector,
            id: `${candidate.relativePath}#${candidate.contentHash}`,
            content: candidate.embeddingContent,
            type: 'file',
            name: path.basename(candidate.filePath),
            path: candidate.relativePath,
            project_path: sharedState.baseDir,
            language: candidate.language,
            content_hash: candidate.contentHash,
            last_modified: candidate.stats.mtime.toISOString(),
          });
        }

        if (recordsToAdd.length > 0) {
          await sharedState.fileTable.add(recordsToAdd);

          try {
            await sharedState.fileTable.optimize();
          } catch (optimizeError) {
            if (optimizeError.message && optimizeError.message.includes('legacy format')) {
              console.warn(
                chalk.yellow(`Skipping optimization due to legacy index format - will be auto-upgraded during normal operations`)
              );
            } else {
              console.warn(
                chalk.yellow(`Warning: Failed to optimize file embeddings table after adding records: ${optimizeError.message}`)
              );
            }
          }

          for (const candidate of filesToActuallyProcess) {
            results.processed++;
            results.files.push(candidate.originalInputPath);
            this.progressTracker.update('processed');
            if (typeof onProgress === 'function') onProgress('processed', candidate.originalInputPath);
            this.processedFiles.set(candidate.originalInputPath, 'processed');
          }
        }
      } catch (error) {
        console.error(chalk.red(`Error processing batch: ${error.message}`));
        for (const candidate of filesToActuallyProcess) {
          results.failed++;
          results.failedFiles.push(candidate.originalInputPath);
          this.progressTracker.update('failed');
          if (typeof onProgress === 'function') onProgress('failed', candidate.originalInputPath);
          this.processedFiles.set(candidate.originalInputPath, 'failed_batch');
        }
      }
    }
  }

  /**
   * Process document chunks
   * @param {string[]} filePaths - File paths to process
   * @param {string} baseDir - Base directory
   * @param {string[]} excludePatterns - Exclude patterns
   * @returns {Promise<void>}
   * @private
   */
  async _processDocumentChunks(candidates, sharedState, verbose = false) {
    verboseLog({ verbose }, chalk.cyan('--- Starting Phase 2: Document Chunk Embeddings ---'));
    if (!sharedState.documentChunkTable) {
      console.warn(chalk.yellow(`Skipping Phase 2: Document Chunk Embeddings because table ${this.documentChunkTable} was not found.`));
      return;
    }

    const allDocChunksToEmbed = [];
    const allDocChunkRecordsToAdd = [];
    const processedDocPathsForDeletion = new Set();
    let skippedDocCount = 0;

    for (const candidate of candidates) {
      if (!candidate.isDocumentation || candidate.readError) {
        continue;
      }

      try {
        if (candidate.stats.size > 5 * 1024 * 1024) {
          continue;
        }

        if (!candidate.fullContent || candidate.fullContent.trim().length === 0) {
          continue;
        }

        const existingChunks = sharedState.existingDocChunksMap.get(candidate.relativePath) || [];
        const { chunks: currentChunks, documentH1 } = extractMarkdownChunks(
          candidate.filePath,
          candidate.fullContent,
          candidate.relativePath
        );

        const currentSignature = currentChunks
          .map(
            (chunk) =>
              `${buildDocumentChunkId(candidate.relativePath, chunk.heading, chunk.start_line_in_doc)}:${createShortHash(chunk.content)}`
          )
          .sort()
          .join('|');
        const existingSignature = buildExistingDocumentSignature(existingChunks);

        if (existingChunks.length > 0 && currentSignature === existingSignature) {
          sharedState.liveDocumentPaths.add(candidate.relativePath);
          skippedDocCount++;
          debug(`Skipping unchanged document: ${candidate.relativePath} (${currentChunks.length} chunks match)`);
          continue;
        }

        if (currentChunks.length === 0) {
          continue;
        }

        sharedState.liveDocumentPaths.add(candidate.relativePath);
        processedDocPathsForDeletion.add(candidate.relativePath);

        for (const chunk of currentChunks) {
          allDocChunksToEmbed.push({
            ...chunk,
            documentTitle: documentH1 || path.basename(candidate.filePath, path.extname(candidate.filePath)),
            fileStats: candidate.stats,
            original_document_path: candidate.relativePath,
          });
        }
      } catch (docError) {
        console.warn(chalk.yellow(`Error processing document ${candidate.relativePath} for chunking: ${docError.message}`));
      }
    }

    if (skippedDocCount > 0) {
      verboseLog({ verbose }, chalk.cyan(`Skipped ${skippedDocCount} unchanged documentation files`));
    }

    if (allDocChunksToEmbed.length > 0) {
      verboseLog({ verbose }, chalk.blue(`Extracted ${allDocChunksToEmbed.length} total document chunks to process for embeddings.`));
      const chunkContentsForBatching = allDocChunksToEmbed.map((chunk) => chunk.content);
      const chunkEmbeddings = await this.modelManager.calculateEmbeddingBatch(chunkContentsForBatching);

      for (let i = 0; i < chunkEmbeddings.length; i++) {
        const chunkData = allDocChunksToEmbed[i];
        const chunkEmbeddingVector = chunkEmbeddings[i];

        if (chunkEmbeddingVector) {
          const chunkContentHash = createShortHash(chunkData.content);
          const chunkId = buildDocumentChunkId(chunkData.original_document_path, chunkData.heading, chunkData.start_line_in_doc);

          const record = {
            id: chunkId,
            content: chunkData.content,
            original_document_path: chunkData.original_document_path,
            project_path: sharedState.baseDir,
            heading_text: chunkData.heading || '',
            document_title: chunkData.documentTitle,
            language: chunkData.language || 'markdown',
            vector: chunkEmbeddingVector,
            content_hash: chunkContentHash,
            last_modified: chunkData.fileStats ? chunkData.fileStats.mtime.toISOString() : new Date().toISOString(),
          };
          allDocChunkRecordsToAdd.push(record);
        }
      }
    }

    // Delete old chunks and add new ones
    if (processedDocPathsForDeletion.size > 0) {
      for (const docPathToDelete of processedDocPathsForDeletion) {
        try {
          await sharedState.documentChunkTable.delete(
            `project_path = '${escapeSqlString(sharedState.baseDir)}' AND original_document_path = '${escapeSqlString(docPathToDelete)}'`
          );
        } catch (deleteError) {
          console.warn(chalk.yellow(`Error deleting chunks for document ${docPathToDelete}: ${deleteError.message}`));
        }
      }
    }

    if (allDocChunkRecordsToAdd.length > 0) {
      try {
        await sharedState.documentChunkTable.add(allDocChunkRecordsToAdd);

        // Optimize table to sync indices with data and prevent TakeExec panics
        try {
          await sharedState.documentChunkTable.optimize();
        } catch (optimizeError) {
          if (optimizeError.message && optimizeError.message.includes('legacy format')) {
            console.warn(chalk.yellow(`Skipping optimization due to legacy index format - will be auto-upgraded during normal operations`));
          } else {
            console.warn(chalk.yellow(`Warning: Failed to optimize document chunk table after adding records: ${optimizeError.message}`));
          }
        }

        verboseLog(
          { verbose },
          chalk.green(`Successfully added ${allDocChunkRecordsToAdd.length} document chunk embeddings to ${this.documentChunkTable}.`)
        );
      } catch (addError) {
        console.error(chalk.red(`Error batch adding document chunk embeddings to DB: ${addError.message}`), addError.stack);
      }
    }

    verboseLog({ verbose }, chalk.green('--- Finished Phase 2: Document Chunk Embeddings ---'));
  }

  async _pruneStaleEmbeddings(sharedState, verbose = false) {
    try {
      const [prunedFiles, prunedDocs] = await Promise.all([
        this.databaseManager.pruneProjectFileEmbeddings(sharedState.baseDir, sharedState.liveFilePaths),
        this.databaseManager.pruneProjectDocumentChunks(sharedState.baseDir, sharedState.liveDocumentPaths),
      ]);
      verboseLog({ verbose }, chalk.cyan(`Pruned ${prunedFiles} stale file embeddings and ${prunedDocs} stale document chunk embeddings.`));
    } catch (error) {
      console.warn(chalk.yellow(`Warning: Failed to prune stale embeddings: ${error.message}`));
    }
  }

  // ============================================================================
  // CLEANUP
  // ============================================================================

  /**
   * Clean up file processor resources
   */
  async cleanup() {
    if (this.cleaningUp) {
      return; // Already cleaning up, prevent duplicate calls
    }

    this.cleaningUp = true;

    try {
      this.processedFiles.clear();
      this.progressTracker.reset(0);
      verboseLog({}, chalk.green('[FileProcessor] Resources cleaned up.'));
    } catch (error) {
      console.error(chalk.red(`[FileProcessor] Error during cleanup: ${error.message}`));
    } finally {
      this.cleaningUp = false;
    }
  }
}
