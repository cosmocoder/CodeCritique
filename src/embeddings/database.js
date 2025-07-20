/**
 * Database Manager Module
 *
 * This module provides centralized database management for embeddings
 * using LanceDB and Apache Arrow.
 *
 * Features:
 * - Database connection management
 * - Table initialization and schema management
 * - Adaptive vector indexing
 * - Project-specific data cleanup
 * - Database maintenance operations
 */

/**
 * @typedef {import('./types.js').DatabaseSchema} DatabaseSchema
 * @typedef {import('@lancedb/lancedb').Connection} LanceDBConnection
 * @typedef {import('@lancedb/lancedb').Table} LanceDBTable
 */

import fs from 'node:fs';
import path from 'node:path';
import * as lancedb from '@lancedb/lancedb';
import { Field, FixedSizeList, Float32, Int32, Schema, Utf8 } from 'apache-arrow';
import chalk from 'chalk';
import { debug } from '../utils/logging.js';
import { EMBEDDING_DIMENSIONS, TABLE_NAMES } from './constants.js';
import { LANCEDB_PATH } from './constants.js';
import { createDatabaseError, ERROR_CODES } from './errors.js';

// ============================================================================
// DATABASE CONFIGURATION
// ============================================================================

// Database Constants
const FILE_EMBEDDINGS_TABLE = TABLE_NAMES.FILE_EMBEDDINGS;
const DOCUMENT_CHUNK_TABLE = TABLE_NAMES.DOCUMENT_CHUNK;
const PR_COMMENTS_TABLE = TABLE_NAMES.PR_COMMENTS;

// ============================================================================
// DATABASE MANAGER CLASS
// ============================================================================

export class DatabaseManager {
  constructor(options = {}) {
    this.dbPath = options.dbPath || LANCEDB_PATH;
    this.embeddingDimensions = options.embeddingDimensions || EMBEDDING_DIMENSIONS;

    // Connection state
    this.dbConnection = null;
    this.tablesInitialized = false;
    this.tableInitializationPromise = null;
    this.cleaningUp = false;

    // Table names
    this.fileEmbeddingsTable = options.fileEmbeddingsTable || FILE_EMBEDDINGS_TABLE;
    this.documentChunkTable = options.documentChunkTable || DOCUMENT_CHUNK_TABLE;
    this.prCommentsTable = options.prCommentsTable || PR_COMMENTS_TABLE;
  }

  // ============================================================================
  // CONNECTION MANAGEMENT
  // ============================================================================

  /**
   * Get database connection, creating it if necessary
   * @returns {Promise<LanceDBConnection>} Database connection
   */
  async getDBConnection() {
    if (!this.dbConnection) {
      console.log(chalk.blue(`Initializing DB connection. Target Path: ${this.dbPath}`));
      if (!fs.existsSync(this.dbPath)) {
        fs.mkdirSync(this.dbPath, { recursive: true });
      }
      this.dbConnection = await lancedb.connect(this.dbPath);
      console.log(chalk.green('LanceDB connected.'));
    }
    return this.dbConnection;
  }

  /**
   * Get database connection with initialized tables
   * @returns {Promise<LanceDBConnection>} Database connection
   */
  async getDB() {
    const db = await this.getDBConnection();
    if (!this.tablesInitialized) {
      await this.initializeTables();
    }
    return db;
  }

  /**
   * Connect to database (compatibility method)
   * @returns {Promise<LanceDBConnection>} Database connection
   */
  async connect() {
    return this.getDB();
  }

  /**
   * Close database connection
   */
  async closeConnection() {
    if (this.dbConnection) {
      console.log('Closing LanceDB connection...');
      await this.dbConnection.close();
      this.dbConnection = null;
      this.tablesInitialized = false;
      this.tableInitializationPromise = null;
      console.log('LanceDB connection closed.');
    }
  }

  // ============================================================================
  // TABLE INITIALIZATION
  // ============================================================================

  /**
   * Initialize database tables
   * @returns {Promise<void>}
   */
  async initializeTables() {
    if (this.tablesInitialized) {
      return;
    }

    // If initialization is already in progress, wait for it to complete
    if (this.tableInitializationPromise) {
      await this.tableInitializationPromise;
      return;
    }

    // Start initialization and store the promise
    this.tableInitializationPromise = (async () => {
      try {
        console.log(chalk.blue('Initializing database tables and indices...'));
        const db = await this.getDBConnection();
        await this.ensureTablesExist(db);
        this.tablesInitialized = true;
        console.log(chalk.green('Database tables and indices initialized successfully.'));
      } catch (error) {
        this.tablesInitialized = false;
        console.error(chalk.red('Failed to initialize database tables:'), error);
        throw error; // Re-throw to propagate the error to callers
      } finally {
        // The initialization attempt is over, clear the promise
        this.tableInitializationPromise = null;
      }
    })();

    await this.tableInitializationPromise;
  }

  /**
   * Ensure all required tables exist with proper schemas
   * @param {LanceDBConnection} db - Database connection
   * @returns {Promise<void>}
   */
  async ensureTablesExist(db) {
    try {
      const tableNames = await db.tableNames();
      const vectorType = new FixedSizeList(this.embeddingDimensions, new Field('item', new Float32(), true));

      // File embeddings table schema
      const fileFields = [
        new Field('id', new Utf8(), false),
        new Field('content', new Utf8(), false),
        new Field('type', new Utf8(), false),
        new Field('name', new Utf8(), false),
        new Field('path', new Utf8(), false),
        new Field('project_path', new Utf8(), false),
        new Field('language', new Utf8(), true),
        new Field('content_hash', new Utf8(), false),
        new Field('last_modified', new Utf8(), false),
        new Field('vector', vectorType, false),
      ];
      const fileSchema = new Schema(fileFields);

      // Document chunk table schema
      const documentChunkFields = [
        new Field('id', new Utf8(), false),
        new Field('content', new Utf8(), false),
        new Field('original_document_path', new Utf8(), false),
        new Field('project_path', new Utf8(), false),
        new Field('heading_text', new Utf8(), true),
        new Field('document_title', new Utf8(), true),
        new Field('language', new Utf8(), true),
        new Field('vector', vectorType, false),
        new Field('content_hash', new Utf8(), false),
        new Field('last_modified', new Utf8(), false),
      ];
      const documentChunkSchema = new Schema(documentChunkFields);

      // PR comments table schema
      const prCommentsSchema = this.createPRCommentsSchema();

      // Create or open tables
      let fileTable, documentChunkTable, prCommentsTable;

      if (!tableNames.includes(this.fileEmbeddingsTable)) {
        console.log(chalk.yellow(`Creating ${this.fileEmbeddingsTable} table with optimized schema...`));
        fileTable = await db.createEmptyTable(this.fileEmbeddingsTable, fileSchema, { mode: 'create' });
        console.log(chalk.green(`Created ${this.fileEmbeddingsTable} table.`));
      } else {
        fileTable = await db.openTable(this.fileEmbeddingsTable);
        await this._checkSchemaCompatibility(fileTable, this.fileEmbeddingsTable, 'project_path');
      }

      if (!tableNames.includes(this.documentChunkTable)) {
        console.log(chalk.yellow(`Creating ${this.documentChunkTable} table with optimized schema...`));
        documentChunkTable = await db.createEmptyTable(this.documentChunkTable, documentChunkSchema, { mode: 'create' });
        console.log(chalk.green(`Created ${this.documentChunkTable} table.`));
      } else {
        documentChunkTable = await db.openTable(this.documentChunkTable);
        await this._checkSchemaCompatibility(documentChunkTable, this.documentChunkTable, 'project_path');
      }

      // Create PR comments table
      if (!tableNames.includes(this.prCommentsTable)) {
        console.log(chalk.yellow(`Creating ${this.prCommentsTable} table with optimized schema...`));
        prCommentsTable = await db.createEmptyTable(this.prCommentsTable, prCommentsSchema, { mode: 'create' });
        console.log(chalk.green(`Created ${this.prCommentsTable} table.`));
      } else {
        prCommentsTable = await db.openTable(this.prCommentsTable);
      }

      // Create FTS indexes
      await this._createFTSIndexes([
        [fileTable, this.fileEmbeddingsTable, 'content'],
        [documentChunkTable, this.documentChunkTable, 'content'],
        [prCommentsTable, this.prCommentsTable, 'comment_text'],
      ]);

      // Create adaptive vector indexes
      await this._createVectorIndexes([
        [fileTable, this.fileEmbeddingsTable, 'vector'],
        [documentChunkTable, this.documentChunkTable, 'vector'],
        [prCommentsTable, this.prCommentsTable, 'combined_embedding'],
      ]);
    } catch (error) {
      console.error(chalk.red(`Error ensuring tables exist: ${error.message}`), error.stack);
      throw error;
    }
  }

  // ============================================================================
  // TABLE OPERATIONS
  // ============================================================================

  /**
   * Get table by name
   * @param {string} tableName - Name of the table
   * @returns {Promise<LanceDBTable|null>} Table instance or null if not found
   */
  async getTable(tableName) {
    try {
      const db = await this.getDBConnection();
      const tableNames = await db.tableNames();
      if (tableNames.includes(tableName)) {
        return await db.openTable(tableName);
      }
      return null;
    } catch (error) {
      console.error(chalk.red(`Error opening table ${tableName}: ${error.message}`), error);
      return null;
    }
  }

  // ============================================================================
  // SCHEMA MANAGEMENT
  // ============================================================================

  /**
   * Create PR comments schema
   * @returns {import('apache-arrow').Schema} PR comments schema
   */
  createPRCommentsSchema() {
    const vectorType = new FixedSizeList(this.embeddingDimensions, new Field('item', new Float32(), true));

    const fields = [
      new Field('id', new Utf8(), false),
      new Field('pr_number', new Int32(), false),
      new Field('repository', new Utf8(), false),
      new Field('project_path', new Utf8(), false),
      new Field('comment_type', new Utf8(), false),
      new Field('comment_text', new Utf8(), false),
      new Field('comment_embedding', vectorType, false),

      // Code context fields
      new Field('file_path', new Utf8(), true),
      new Field('line_number', new Int32(), true),
      new Field('line_range_start', new Int32(), true),
      new Field('line_range_end', new Int32(), true),
      new Field('original_code', new Utf8(), true),
      new Field('suggested_code', new Utf8(), true),
      new Field('diff_hunk', new Utf8(), true),

      // Code embedding
      new Field('code_embedding', vectorType, true),
      new Field('combined_embedding', vectorType, false),

      // Metadata
      new Field('author', new Utf8(), false),
      new Field('created_at', new Utf8(), false),
      new Field('updated_at', new Utf8(), true),
      new Field('review_id', new Utf8(), true),
      new Field('review_state', new Utf8(), true),

      // Analysis metadata
      new Field('issue_category', new Utf8(), true),
      new Field('severity', new Utf8(), true),
      new Field('pattern_tags', new Utf8(), true),
    ];

    return new Schema(fields);
  }

  // ============================================================================
  // INDEXING
  // ============================================================================

  /**
   * Create adaptive vector indexes based on dataset size
   * @param {LanceDBTable} table - Table instance
   * @param {string} tableName - Table name
   * @param {string} vectorField - Vector field name
   * @returns {Promise<Object>} Index information
   */
  async createAdaptiveVectorIndexes(table, tableName, vectorField = 'vector') {
    try {
      const rowCount = await table.countRows();
      console.log(chalk.blue(`[${tableName}] Row count: ${rowCount}`));

      if (rowCount < 100) {
        console.log(chalk.blue(`[${tableName}] Skipping indexing for small dataset (${rowCount} rows). Using exact search.`));
        return { indexType: 'exact', rowCount };
      } else if (rowCount < 1000) {
        console.log(chalk.blue(`[${tableName}] Using exact search for small dataset (${rowCount} rows) - no index needed`));
        return { indexType: 'exact', rowCount };
      } else if (rowCount < 10000) {
        const numPartitions = Math.max(Math.floor(Math.sqrt(rowCount / 50)), 2);
        console.log(
          chalk.blue(`[${tableName}] Creating/updating IVF-Flat index for medium dataset (${rowCount} rows, ${numPartitions} partitions)`)
        );
        await table.createIndex(vectorField, {
          config: lancedb.Index.ivfFlat({ numPartitions }),
          replace: false,
        });
        return { indexType: 'ivf_flat', rowCount, numPartitions };
      } else {
        const numPartitions = Math.max(Math.floor(Math.sqrt(rowCount / 100)), 8);
        const numSubVectors = Math.floor(this.embeddingDimensions / 4);
        console.log(
          chalk.blue(`[${tableName}] Creating/updating IVF-PQ index for large dataset (${rowCount} rows, ${numPartitions} partitions)`)
        );
        await table.createIndex(vectorField, {
          config: lancedb.Index.ivfPq({
            numPartitions,
            numSubVectors,
            numBits: 8,
          }),
          replace: false,
        });
        return { indexType: 'ivf_pq', rowCount, numPartitions, numSubVectors };
      }
    } catch (error) {
      if (error.message.includes('already exists')) {
        console.log(chalk.green(`[${tableName}] Index already up-to-date.`));
        return { indexType: 'existing' };
      }
      console.warn(chalk.yellow(`[${tableName}] Index creation/update failed: ${error.message}. Falling back to exact search.`));
      return { indexType: 'exact_fallback', error: error.message };
    }
  }

  // ============================================================================
  // CLEANUP OPERATIONS
  // ============================================================================

  /**
   * Clean up database connection and resources
   */
  async cleanup() {
    if (this.cleaningUp) {
      return; // Already cleaning up, prevent duplicate calls
    }

    this.cleaningUp = true;

    try {
      await this.closeConnection();
      console.log(chalk.green('Database resources cleaned up.'));
    } catch (error) {
      console.error(`Error during database cleanup: ${error.message}`);
    } finally {
      this.cleaningUp = false;
    }
  }

  /**
   * Clear all embeddings by dropping tables
   * @returns {Promise<boolean>} Success status
   */
  async clearAllEmbeddings() {
    let db = null;
    try {
      console.log(chalk.cyan('Clearing ALL embeddings by dropping tables...'));
      console.log(chalk.red('WARNING: This will affect all projects on this machine!'));

      if (!fs.existsSync(this.dbPath)) {
        console.log(chalk.yellow('LanceDB directory does not exist, nothing to clear.'));
        return true;
      }

      db = await lancedb.connect(this.dbPath);
      const tableNames = await db.tableNames();
      let droppedCount = 0;

      for (const tableName of [this.fileEmbeddingsTable, this.documentChunkTable, this.prCommentsTable]) {
        if (tableNames.includes(tableName)) {
          console.log(chalk.yellow(`Dropping table ${tableName}...`));
          await db.dropTable(tableName);
          console.log(chalk.green(`Table ${tableName} dropped.`));
          droppedCount++;
        } else {
          console.log(chalk.yellow(`Table ${tableName} does not exist.`));
        }
      }

      if (droppedCount > 0) {
        console.log(chalk.green('All embedding tables have been dropped.'));
        console.log(chalk.yellow('Run the embedding generation process again to recreate tables.'));
      } else {
        console.log(chalk.green('No embedding tables found to drop.'));
      }

      // Reset connection state
      this.dbConnection = null;
      this.tablesInitialized = false;
      return true;
    } catch (error) {
      console.error(chalk.red(`Error clearing embeddings: ${error.message}`), error);
      this.dbConnection = null;
      this.tablesInitialized = false;
      throw error;
    }
  }

  /**
   * Clear embeddings for a specific project
   * @param {string} projectPath - Project path
   * @returns {Promise<boolean>} Success status
   */
  async clearProjectEmbeddings(projectPath = process.cwd()) {
    let db = null;
    try {
      const resolvedProjectPath = path.resolve(projectPath);
      const projectName = path.basename(resolvedProjectPath);

      // Safety check: ensure project path is valid and not root
      if (!resolvedProjectPath || resolvedProjectPath === '/' || resolvedProjectPath === path.resolve('/')) {
        throw new Error(`Invalid project path: ${resolvedProjectPath}. Cannot clear embeddings for root directory.`);
      }

      // Additional safety: ensure project path is not too generic
      const pathParts = resolvedProjectPath.split(path.sep);
      if (pathParts.length <= 2) {
        throw new Error(`Project path too generic: ${resolvedProjectPath}. For safety, project must be at least 3 levels deep.`);
      }

      console.log(chalk.cyan(`Clearing embeddings for project: ${resolvedProjectPath} (${projectName})`));

      if (!fs.existsSync(this.dbPath)) {
        console.log(chalk.yellow('LanceDB directory does not exist, nothing to clear.'));
        return true;
      }

      db = await lancedb.connect(this.dbPath);
      const tableNames = await db.tableNames();
      let deletedCount = 0;

      // Clear file embeddings for this project
      if (tableNames.includes(this.fileEmbeddingsTable)) {
        const fileTable = await db.openTable(this.fileEmbeddingsTable);
        await this._validateTableHasProjectPath(fileTable, this.fileEmbeddingsTable);
        deletedCount += await this._clearProjectTableRecords(
          db,
          this.fileEmbeddingsTable,
          resolvedProjectPath,
          projectName,
          'project_path'
        );
      }

      // Clear document chunk embeddings for this project
      if (tableNames.includes(this.documentChunkTable)) {
        const docTable = await db.openTable(this.documentChunkTable);
        await this._validateTableHasProjectPath(docTable, this.documentChunkTable);
        deletedCount += await this._clearProjectTableRecords(db, this.documentChunkTable, resolvedProjectPath, projectName, 'project_path');
      }

      // Note: PR comments are cleared via separate pr-history:clear command
      // This embeddings:clear command only handles file and document embeddings

      if (deletedCount > 0) {
        console.log(chalk.green(`Successfully cleared ${deletedCount} embeddings for project: ${resolvedProjectPath}`));
      } else {
        console.log(chalk.yellow(`No embeddings found for project: ${resolvedProjectPath}`));
      }

      return true;
    } catch (error) {
      console.error(chalk.red(`Error clearing project embeddings: ${error.message}`), error);
      throw error;
    }
  }

  // ============================================================================
  // PRIVATE METHODS
  // ============================================================================

  /**
   * Check schema compatibility for existing tables
   * @param {LanceDBTable} table - Table instance
   * @param {string} tableName - Table name
   * @param {string} requiredField - Required field name
   * @private
   */
  async _checkSchemaCompatibility(table, tableName, requiredField) {
    try {
      const currentSchema = await table.schema;
      if (currentSchema && currentSchema.fields) {
        const hasRequiredField = currentSchema.fields.some((field) => field.name === requiredField);
        if (!hasRequiredField) {
          console.log(chalk.yellow(`Table ${tableName} has old schema without ${requiredField}. Migration needed.`));
          console.log(chalk.yellow(`Please clear embeddings and regenerate them to use the new schema with project isolation.`));
        }
      }
    } catch (schemaError) {
      debug(`Could not check schema for ${tableName}: ${schemaError.message}`);
    }
  }

  /**
   * Validate that a table has the project_path field for proper project isolation
   * @param {LanceDBTable} table - Table instance
   * @param {string} tableName - Table name
   * @throws {Error} If table doesn't have project_path field
   * @private
   */
  async _validateTableHasProjectPath(table, tableName) {
    try {
      const currentSchema = await table.schema;
      if (currentSchema && currentSchema.fields) {
        const hasProjectPath = currentSchema.fields.some((field) => field.name === 'project_path');
        if (!hasProjectPath) {
          throw new Error(
            `Table ${tableName} does not have project_path field. Cannot perform project-specific cleanup. Please regenerate embeddings to use the new schema with project isolation.`
          );
        }
        console.log(chalk.green(`✓ Table ${tableName} has project_path field for proper isolation`));
      } else {
        console.log(chalk.yellow(`Table ${tableName} has no readable schema, skipping validation`));
      }
    } catch (schemaError) {
      // If we can't read the schema, it might be because the table is empty or doesn't exist
      // In this case, we should just warn and continue
      console.log(chalk.yellow(`Warning: Could not validate schema for ${tableName}: ${schemaError.message}`));
    }
  }

  /**
   * Create FTS indexes for tables
   * @param {Array} tableSpecs - Array of [table, tableName, contentField] tuples
   * @private
   */
  async _createFTSIndexes(tableSpecs) {
    console.log(chalk.blue('Creating native FTS indexes...'));

    for (const [table, tableName, contentField] of tableSpecs) {
      try {
        await table.createIndex(contentField, { config: lancedb.Index.fts(), replace: false });
        console.log(chalk.green(`FTS index created/updated for ${tableName}`));
      } catch (error) {
        if (error.message.toLowerCase().includes('already exists')) {
          console.log(chalk.green(`FTS index already exists for ${tableName}.`));
        } else {
          console.warn(chalk.yellow(`FTS index warning for ${tableName}: ${error.message}`));
        }
      }
    }
  }

  /**
   * Create vector indexes for tables
   * @param {Array} tableSpecs - Array of [table, tableName, vectorField] tuples
   * @private
   */
  async _createVectorIndexes(tableSpecs) {
    console.log(chalk.blue('Creating adaptive vector indexes...'));

    const indexResults = [];
    for (const [table, tableName, vectorField] of tableSpecs) {
      const indexInfo = await this.createAdaptiveVectorIndexes(table, tableName, vectorField);
      indexResults.push(indexInfo);
    }

    console.log(chalk.green(`Indexing complete - ${JSON.stringify(indexResults)}`));
  }

  /**
   * Clear records from a specific table for a project
   * @param {LanceDBConnection} db - Database connection
   * @param {string} tableName - Table name
   * @param {string} resolvedProjectPath - Resolved project path
   * @param {string} projectName - Project name
   * @param {string} pathField - Path field name
   * @returns {Promise<number>} Number of deleted records
   * @private
   */
  async _clearProjectTableRecords(db, tableName, resolvedProjectPath, projectName, pathField) {
    const table = await db.openTable(tableName);
    const allRecords = await table.query().toArray();

    const projectRecords = allRecords.filter((record) => {
      if (!record[pathField]) return false;

      // Check for project-specific structure
      if (record.id === `__project_structure__${projectName}` || record.id === '__project_structure__') {
        return true;
      }

      // Check if this record belongs to the current project
      try {
        if (pathField === 'project_path') {
          // For project_path field, do direct equality check
          return record[pathField] === resolvedProjectPath;
        } else {
          // For other path fields (like 'path'), resolve relative to project path
          const absolutePath = path.resolve(resolvedProjectPath, record[pathField]);
          return absolutePath.startsWith(resolvedProjectPath);
        }
      } catch {
        return false;
      }
    });

    if (projectRecords.length > 0) {
      console.log(chalk.blue(`Found ${projectRecords.length} ${tableName} records for this project`));

      let deletedCount = 0;
      for (const record of projectRecords) {
        try {
          await table.delete(`id = '${record.id.replace(/'/g, "''")}'`);
          deletedCount++;
        } catch (deleteError) {
          console.warn(chalk.yellow(`Warning: Could not delete record ${record.id}: ${deleteError.message}`));
        }
      }

      console.log(chalk.green(`Deleted ${deletedCount} ${tableName} records for this project`));
      return deletedCount;
    } else {
      console.log(chalk.yellow(`No ${tableName} records found for this project`));
      return 0;
    }
  }

  /**
   * Update the vector index for the PR comments table
   * @returns {Promise<void>}
   */
  async updatePRCommentsIndex() {
    try {
      const table = await this.getTable(this.prCommentsTable);
      if (table) {
        console.log(chalk.blue(`Updating vector index for ${this.prCommentsTable}...`));
        await this.createAdaptiveVectorIndexes(table, this.prCommentsTable, 'combined_embedding');
        console.log(chalk.green(`Vector index for ${this.prCommentsTable} updated.`));
      }
    } catch (error) {
      console.error(chalk.red(`Error updating PR comments index: ${error.message}`));
      throw createDatabaseError(`Failed to update PR comments index: ${error.message}`, ERROR_CODES.INDEX_UPDATE_ERROR, error);
    }
  }
}
