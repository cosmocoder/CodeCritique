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
import { isDocumentationFile, shouldProcessFile as utilsShouldProcessFile } from '../utils/file-validation.js';
import { detectLanguageFromExtension } from '../utils/language-detection.js';
import { debug } from '../utils/logging.js';
import { extractMarkdownChunks } from '../utils/markdown.js';
import { slugify } from '../utils/string-utils.js';
import { TABLE_NAMES, LANCEDB_DIR_NAME, FASTEMBED_CACHE_DIR_NAME } from './constants.js';
import { createFileProcessingError } from './errors.js';

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
    console.log(chalk.cyan('[generateDirEmb] Starting...')); // Log entry

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

      // Create project-specific structure ID based on the root directory
      const rootDir = options.rootDir || process.cwd();
      const projectName = path.basename(path.resolve(rootDir));
      const structureId = `__project_structure__${projectName}`;

      try {
        await table.delete(`id = '${structureId}'`);
        debug('[generateDirEmb] Deleted existing project structure embedding');
      } catch (error) {
        if (!error.message.includes('Record not found') && !error.message.includes('cannot find')) {
          debug(`[generateDirEmb] Error deleting existing project structure: ${error.message}`);
        } else {
          debug('[generateDirEmb] No existing project structure to delete.');
        }
      }

      const directoryStructure = this.generateDirectoryStructure(options);
      if (!directoryStructure) throw new Error('[generateDirEmb] Failed to generate directory structure string');
      debug('[generateDirEmb] Directory structure string generated.');

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
        type: 'directory-structure',
        name: `${projectName} Project Structure`,
        path: `${projectName} Project Structure`, // Project-specific path
        project_path: path.resolve(rootDir), // Add project path for consistency with new schema
        language: 'text',
        content_hash: createHash('md5').update(directoryStructure).digest('hex').substring(0, 8),
        last_modified: new Date().toISOString(), // Use current timestamp for directory structure
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
        console.log(chalk.green('[generateDirEmb] Successfully added directory structure embedding.'));
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
      onProgress, // <<< Add onProgress here
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

    console.log(chalk.blue('Ensuring database tables exist before batch processing...'));
    try {
      await this.databaseManager.getDB();
      console.log(chalk.green('Database table check complete.'));
    } catch (dbError) {
      console.error(chalk.red(`Failed to initialize database or tables: ${dbError.message}. Aborting batch process.`));
      return { processed: 0, failed: filePaths.length, skipped: 0, excluded: 0, files: [], failedFiles: [...filePaths], excludedFiles: [] };
    }

    const results = { processed: 0, failed: 0, skipped: 0, excluded: 0, files: [], failedFiles: [], excludedFiles: [] };
    const exclusionOptions = { excludePatterns, respectGitignore, baseDir: resolvedCanonicalBaseDir };
    this.processedFiles.clear();
    this.progressTracker.reset(filePaths.length);
    console.log(chalk.blue(`Starting batch processing of ${filePaths.length} files...`));

    // Generate directory structure embedding first
    try {
      await this.generateDirectoryStructureEmbedding({
        rootDir: resolvedCanonicalBaseDir,
        maxDepth: 5,
        ignorePatterns: excludePatterns,
        showFiles: true,
      });
    } catch (structureError) {
      console.warn(chalk.yellow(`Warning: Failed to generate directory structure embedding: ${structureError.message}`));
    }

    const fileTable = await this.databaseManager.getTable(this.fileEmbeddingsTable);
    if (!fileTable) {
      console.error(chalk.red(`Table ${this.fileEmbeddingsTable} not found. Aborting batch file embedding.`));
      results.failed = filePaths.length;
      results.failedFiles = [...filePaths];
      this.progressTracker.failedCount = filePaths.length;
      this.progressTracker.update('failed');
      return results;
    }

    // Process files in batches
    console.log(chalk.cyan('--- Starting Phase 1: File Embeddings ---'));
    const BATCH_SIZE = 50; // Process files in smaller batches for better performance

    for (let i = 0; i < filePaths.length; i += BATCH_SIZE) {
      const batch = filePaths.slice(i, i + BATCH_SIZE);
      const batchResults = await this._processBatch(batch, resolvedCanonicalBaseDir, exclusionOptions, onProgress, maxLines);

      // Merge results
      results.processed += batchResults.processed;
      results.failed += batchResults.failed;
      results.skipped += batchResults.skipped;
      results.excluded += batchResults.excluded;
      results.files.push(...batchResults.files);
      results.failedFiles.push(...batchResults.failedFiles);
      results.excludedFiles.push(...batchResults.excludedFiles);
    }

    // Process document chunks
    await this._processDocumentChunks(filePaths, resolvedCanonicalBaseDir, excludePatterns);

    console.log(chalk.green(`Batch processing complete!`));

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
  async _processBatch(filePaths, baseDir, exclusionOptions, onProgress, maxLines = 1000) {
    const results = { processed: 0, failed: 0, skipped: 0, excluded: 0, files: [], failedFiles: [], excludedFiles: [] };
    const filesToProcess = [];
    const contentsForBatch = [];

    // Filter and prepare files for processing
    for (const filePath of filePaths) {
      const absoluteFilePath = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(baseDir, filePath);
      const consistentRelativePath = path.relative(baseDir, absoluteFilePath);

      // Check if file should be processed
      if (
        !utilsShouldProcessFile(absoluteFilePath, '', {
          ...exclusionOptions,
          baseDir: baseDir,
          relativePathToCheck: consistentRelativePath,
        })
      ) {
        results.excluded++;
        results.excludedFiles.push(filePath);
        this.progressTracker.update('skipped');
        if (typeof onProgress === 'function') onProgress('excluded', filePath);
        this.processedFiles.set(filePath, 'excluded');
        continue;
      }

      try {
        const stats = fs.statSync(absoluteFilePath);

        // Read file content
        let content = await fs.promises.readFile(absoluteFilePath, 'utf8');

        // Truncate content to maximum specified lines for code files only (documentation files are chunked separately)
        const isDocFile = isDocumentationFile(absoluteFilePath);
        if (!isDocFile) {
          const lines = content.split('\n');
          if (lines.length > maxLines) {
            content = lines.slice(0, maxLines).join('\n') + '\n... (truncated from ' + lines.length + ' lines)';
            debug(`Truncated code file ${consistentRelativePath} from ${lines.length} lines to ${maxLines} lines`);
          }
        }

        if (content.trim().length === 0) {
          results.skipped++;
          this.progressTracker.update('skipped');
          if (typeof onProgress === 'function') onProgress('skipped', filePath);
          this.processedFiles.set(filePath, 'skipped_empty');
          continue;
        }

        filesToProcess.push({
          filePath: absoluteFilePath,
          originalInputPath: filePath,
          content,
          relativePath: consistentRelativePath,
          stats,
        });
        contentsForBatch.push(content);
      } catch {
        results.failed++;
        results.failedFiles.push(filePath);
        this.progressTracker.update('failed');
        if (typeof onProgress === 'function') onProgress('failed', filePath);
        this.processedFiles.set(filePath, 'failed_read');
      }
    }

    // Efficient batch check: Get all existing embeddings for this project in one query
    const fileTable = await this.databaseManager.getTable(this.fileEmbeddingsTable);
    const filesToActuallyProcess = [];
    const contentsToActuallyProcess = [];
    let existingFilesMap = new Map();

    try {
      // Single query to get all existing file embeddings for this project
      const existingRecords = await fileTable
        .query()
        .where(`project_path = '${baseDir.replace(/'/g, "''")}'`)
        .toArray();

      // Build a map for fast lookup: path -> [records]
      for (const record of existingRecords) {
        if (!existingFilesMap.has(record.path)) {
          existingFilesMap.set(record.path, []);
        }
        existingFilesMap.get(record.path).push(record);
      }

      console.log(chalk.cyan(`Found ${existingRecords.length} existing embeddings for comparison`));
    } catch (queryError) {
      console.warn(chalk.yellow(`Warning: Could not query existing embeddings, will process all files: ${queryError.message}`));
      existingFilesMap = new Map(); // Empty map means process all files
    }

    // Now check each file against the existing embeddings map
    const recordsToDelete = [];

    for (let i = 0; i < filesToProcess.length; i++) {
      const fileData = filesToProcess[i];
      const contentHash = createHash('md5').update(fileData.content).digest('hex').substring(0, 8);

      const existingRecords = existingFilesMap.get(fileData.relativePath) || [];
      let needsUpdate = true;

      if (existingRecords.length > 0) {
        // Check if any existing record matches our current file state
        for (const existing of existingRecords) {
          if (existing.content_hash === contentHash) {
            // File content hasn't changed - skip processing (CI-friendly)
            // Note: We rely on content_hash rather than last_modified because
            // GitHub Actions checkout changes file timestamps even for unchanged files
            needsUpdate = false;
            results.skipped++;
            this.progressTracker.update('skipped');
            if (typeof onProgress === 'function') onProgress('skipped', fileData.originalInputPath);
            this.processedFiles.set(fileData.originalInputPath, 'skipped_unchanged');
            debug(`Skipping unchanged file: ${fileData.relativePath} (hash: ${contentHash})`);
            break;
          } else if (existing.path === fileData.relativePath) {
            // Same file path but different content - mark old version for deletion
            recordsToDelete.push(existing);
          }
        }
      }

      if (needsUpdate) {
        // File needs processing (new or changed)
        filesToActuallyProcess.push(fileData);
        contentsToActuallyProcess.push(fileData.content);
      }
    }

    // Batch delete old versions if any
    if (recordsToDelete.length > 0) {
      for (const recordToDelete of recordsToDelete) {
        try {
          await fileTable.delete(`id = '${recordToDelete.id.replace(/'/g, "''")}'`);
          debug(`Deleted old version: ${recordToDelete.path} (old hash: ${recordToDelete.content_hash})`);
        } catch (deleteError) {
          console.warn(chalk.yellow(`Warning: Could not delete old version of ${recordToDelete.path}: ${deleteError.message}`));
        }
      }
    }

    // Generate embeddings only for files that need processing
    if (filesToActuallyProcess.length > 0) {
      console.log(
        chalk.cyan(
          `Processing ${filesToActuallyProcess.length} new/changed files (skipped ${filesToProcess.length - filesToActuallyProcess.length} unchanged)`
        )
      );

      try {
        const embeddings = await this.modelManager.calculateEmbeddingBatch(contentsToActuallyProcess);
        const recordsToAdd = [];

        for (let i = 0; i < embeddings.length; i++) {
          const fileData = filesToActuallyProcess[i];
          const embeddingVector = embeddings[i];

          if (embeddingVector) {
            const contentHash = createHash('md5').update(fileData.content).digest('hex').substring(0, 8);
            const fileId = `${fileData.relativePath}#${contentHash}`;

            const record = {
              vector: embeddingVector,
              id: fileId,
              content: fileData.content,
              type: 'file',
              name: path.basename(fileData.filePath),
              path: fileData.relativePath,
              project_path: baseDir,
              language: detectLanguageFromExtension(path.extname(fileData.filePath)),
              content_hash: contentHash,
              last_modified: fileData.stats.mtime.toISOString(),
            };
            recordsToAdd.push(record);
          } else {
            results.failed++;
            results.failedFiles.push(fileData.originalInputPath);
            this.progressTracker.update('failed');
            if (typeof onProgress === 'function') onProgress('failed', fileData.originalInputPath);
            this.processedFiles.set(fileData.originalInputPath, 'failed_embedding');
          }
        }

        // Add new/updated records to database
        if (recordsToAdd.length > 0) {
          await fileTable.add(recordsToAdd);

          // Optimize table to sync indices with data and prevent TakeExec panics
          try {
            await fileTable.optimize();
          } catch (optimizeError) {
            if (optimizeError.message && optimizeError.message.includes('legacy format')) {
              console.log(
                chalk.yellow(`Skipping optimization due to legacy index format - will be auto-upgraded during normal operations`)
              );
            } else {
              console.warn(
                chalk.yellow(`Warning: Failed to optimize file embeddings table after adding records: ${optimizeError.message}`)
              );
            }
          }

          recordsToAdd.forEach((record, index) => {
            const fileData = filesToActuallyProcess[index];
            if (embeddings[index]) {
              results.processed++;
              results.files.push(fileData.originalInputPath);
              this.progressTracker.update('processed');
              if (typeof onProgress === 'function') onProgress('processed', fileData.originalInputPath);
              this.processedFiles.set(fileData.originalInputPath, 'processed');
            }
          });
        }
      } catch (error) {
        console.error(chalk.red(`Error processing batch: ${error.message}`));
        filesToProcess.forEach((fileData) => {
          results.failed++;
          results.failedFiles.push(fileData.originalInputPath);
          this.progressTracker.update('failed');
          if (typeof onProgress === 'function') onProgress('failed', fileData.originalInputPath);
          this.processedFiles.set(fileData.originalInputPath, 'failed_batch');
        });
      }
    }

    return results;
  }

  /**
   * Process document chunks
   * @param {string[]} filePaths - File paths to process
   * @param {string} baseDir - Base directory
   * @param {string[]} excludePatterns - Exclude patterns
   * @returns {Promise<void>}
   * @private
   */
  async _processDocumentChunks(filePaths, baseDir) {
    console.log(chalk.cyan('--- Starting Phase 2: Document Chunk Embeddings ---'));
    const documentChunkTable = await this.databaseManager.getTable(this.documentChunkTable);
    if (!documentChunkTable) {
      console.warn(chalk.yellow(`Skipping Phase 2: Document Chunk Embeddings because table ${this.documentChunkTable} was not found.`));
      return;
    }

    // Efficient batch check: Get all existing document chunks for this project
    let existingDocChunksMap = new Map();
    try {
      const existingChunks = await documentChunkTable
        .query()
        .where(`project_path = '${baseDir.replace(/'/g, "''")}'`)
        .toArray();

      // Build a map for fast lookup: original_document_path -> [chunks]
      for (const chunk of existingChunks) {
        if (!existingDocChunksMap.has(chunk.original_document_path)) {
          existingDocChunksMap.set(chunk.original_document_path, []);
        }
        existingDocChunksMap.get(chunk.original_document_path).push(chunk);
      }

      console.log(chalk.cyan(`Found ${existingChunks.length} existing document chunks for comparison`));
    } catch (queryError) {
      console.warn(chalk.yellow(`Warning: Could not query existing document chunks, will process all docs: ${queryError.message}`));
      existingDocChunksMap = new Map();
    }

    const allDocChunksToEmbed = [];
    const allDocChunkRecordsToAdd = [];
    const processedDocPathsForDeletion = new Set();
    let skippedDocCount = 0;

    for (const filePath of filePaths) {
      const absoluteFilePath = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(baseDir, filePath);
      const consistentRelativePath = path.relative(baseDir, absoluteFilePath);
      const language = detectLanguageFromExtension(path.extname(absoluteFilePath));

      if (isDocumentationFile(absoluteFilePath, language)) {
        try {
          const stats = fs.statSync(absoluteFilePath);
          if (stats.size > 5 * 1024 * 1024) {
            // 5MB limit for docs
            continue;
          }

          const content = await fs.promises.readFile(absoluteFilePath, 'utf8');
          if (content.trim().length === 0) {
            continue;
          }

          // Check if document has changed by comparing chunk content hashes
          const existingChunks = existingDocChunksMap.get(consistentRelativePath) || [];

          // Extract chunks to compare with existing ones
          const { chunks: currentChunks, documentH1 } = extractMarkdownChunks(absoluteFilePath, content, consistentRelativePath);
          let hasUnchangedDocument = false;

          if (existingChunks.length > 0 && currentChunks.length === existingChunks.length) {
            // Create a signature of the document by combining all chunk content hashes
            const currentChunkHashes = currentChunks
              .map((chunk) => createHash('md5').update(chunk.content).digest('hex').substring(0, 8))
              .sort()
              .join('|');

            const existingChunkHashes = existingChunks
              .map((chunk) => chunk.content_hash)
              .sort()
              .join('|');

            hasUnchangedDocument = currentChunkHashes === existingChunkHashes;
          }

          if (hasUnchangedDocument) {
            // Document hasn't changed - skip processing
            skippedDocCount++;
            debug(`Skipping unchanged document: ${consistentRelativePath} (${currentChunks.length} chunks match)`);
            continue;
          }

          // Document has changed or is new - process it
          if (!processedDocPathsForDeletion.has(consistentRelativePath)) {
            processedDocPathsForDeletion.add(consistentRelativePath);
          }

          if (currentChunks.length > 0) {
            currentChunks.forEach((chunk) => {
              const chunkWithTitle = {
                ...chunk,
                documentTitle: documentH1 || path.basename(absoluteFilePath, path.extname(absoluteFilePath)),
                fileStats: stats,
              };
              allDocChunksToEmbed.push(chunkWithTitle);
            });
          }
        } catch (docError) {
          console.warn(chalk.yellow(`Error processing document ${consistentRelativePath} for chunking: ${docError.message}`));
        }
      }
    }

    if (skippedDocCount > 0) {
      console.log(chalk.cyan(`Skipped ${skippedDocCount} unchanged documentation files`));
    }

    if (allDocChunksToEmbed.length > 0) {
      console.log(chalk.blue(`Extracted ${allDocChunksToEmbed.length} total document chunks to process for embeddings.`));
      const chunkContentsForBatching = allDocChunksToEmbed.map((chunk) => chunk.content);
      const chunkEmbeddings = await this.modelManager.calculateEmbeddingBatch(chunkContentsForBatching);

      for (let i = 0; i < chunkEmbeddings.length; i++) {
        const chunkData = allDocChunksToEmbed[i];
        const chunkEmbeddingVector = chunkEmbeddings[i];

        if (chunkEmbeddingVector) {
          const chunkContentHash = createHash('md5').update(chunkData.content).digest('hex').substring(0, 8);
          const chunkId = `${chunkData.original_document_path}#${slugify(chunkData.heading || 'section')}_${chunkData.start_line_in_doc}`;

          const record = {
            id: chunkId,
            content: chunkData.content,
            original_document_path: chunkData.original_document_path,
            project_path: baseDir,
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
          await documentChunkTable.delete(`original_document_path = '${docPathToDelete.replace(/'/g, "''")}'`);
        } catch (deleteError) {
          console.warn(chalk.yellow(`Error deleting chunks for document ${docPathToDelete}: ${deleteError.message}`));
        }
      }
    }

    if (allDocChunkRecordsToAdd.length > 0) {
      try {
        await documentChunkTable.add(allDocChunkRecordsToAdd);

        // Optimize table to sync indices with data and prevent TakeExec panics
        try {
          await documentChunkTable.optimize();
        } catch (optimizeError) {
          if (optimizeError.message && optimizeError.message.includes('legacy format')) {
            console.log(chalk.yellow(`Skipping optimization due to legacy index format - will be auto-upgraded during normal operations`));
          } else {
            console.warn(chalk.yellow(`Warning: Failed to optimize document chunk table after adding records: ${optimizeError.message}`));
          }
        }

        console.log(
          chalk.green(`Successfully added ${allDocChunkRecordsToAdd.length} document chunk embeddings to ${this.documentChunkTable}.`)
        );
      } catch (addError) {
        console.error(chalk.red(`Error batch adding document chunk embeddings to DB: ${addError.message}`), addError.stack);
      }
    }

    console.log(chalk.green('--- Finished Phase 2: Document Chunk Embeddings ---'));
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
      console.log(chalk.green('[FileProcessor] Resources cleaned up.'));
    } catch (error) {
      console.error(chalk.red(`[FileProcessor] Error during cleanup: ${error.message}`));
    } finally {
      this.cleaningUp = false;
    }
  }
}
