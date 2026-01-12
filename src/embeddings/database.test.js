import fs from 'node:fs';
import * as lancedb from '@lancedb/lancedb';
import { DatabaseManager } from './database.js';

vi.mock('@lancedb/lancedb', () => ({
  connect: vi.fn(),
  Index: {
    fts: vi.fn(() => 'fts-config'),
    ivfFlat: vi.fn((opts) => ({ type: 'ivf_flat', ...opts })),
    ivfPq: vi.fn((opts) => ({ type: 'ivf_pq', ...opts })),
  },
}));

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    default: {
      ...original,
      existsSync: vi.fn(),
      mkdirSync: vi.fn(),
    },
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

// chalk mock is provided globally in setupTests.js

describe('DatabaseManager', () => {
  let dbManager;
  let mockDb;
  let mockTable;

  beforeEach(() => {
    mockConsole();

    // Create mock table
    mockTable = {
      countRows: vi.fn().mockResolvedValue(50),
      createIndex: vi.fn().mockResolvedValue(undefined),
      schema: { fields: [{ name: 'project_path' }] },
      query: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue([]),
      }),
      add: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      optimize: vi.fn().mockResolvedValue(undefined),
    };

    // Create mock database connection
    mockDb = {
      tableNames: vi.fn().mockResolvedValue([]),
      createEmptyTable: vi.fn().mockResolvedValue(mockTable),
      openTable: vi.fn().mockResolvedValue(mockTable),
      dropTable: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };

    lancedb.connect.mockResolvedValue(mockDb);
    fs.existsSync.mockReturnValue(true);

    dbManager = new DatabaseManager({
      dbPath: '/test/db/path',
      embeddingDimensions: 384,
    });
  });

  describe('constructor', () => {
    it('should initialize with default options', () => {
      const manager = new DatabaseManager();
      expect(manager.embeddingDimensions).toBe(384);
      expect(manager.dbConnection).toBeNull();
      expect(manager.tablesInitialized).toBe(false);
    });

    it('should accept custom options', () => {
      const manager = new DatabaseManager({
        dbPath: '/custom/path',
        embeddingDimensions: 768,
      });
      expect(manager.dbPath).toBe('/custom/path');
      expect(manager.embeddingDimensions).toBe(768);
    });
  });

  describe('getDBConnection', () => {
    it('should create database connection', async () => {
      const db = await dbManager.getDBConnection();

      expect(lancedb.connect).toHaveBeenCalledWith('/test/db/path');
      expect(db).toBe(mockDb);
    });

    it('should create database directory if not exists', async () => {
      fs.existsSync.mockReturnValue(false);

      await dbManager.getDBConnection();

      expect(fs.mkdirSync).toHaveBeenCalledWith('/test/db/path', { recursive: true });
    });

    it('should reuse existing connection', async () => {
      await dbManager.getDBConnection();
      await dbManager.getDBConnection();

      expect(lancedb.connect).toHaveBeenCalledTimes(1);
    });
  });

  describe('getDB', () => {
    it('should get connection and initialize tables', async () => {
      const db = await dbManager.getDB();

      expect(db).toBe(mockDb);
      expect(dbManager.tablesInitialized).toBe(true);
    });

    it('should not reinitialize tables on subsequent calls', async () => {
      await dbManager.getDB();
      await dbManager.getDB();

      // tableNames should be called during initialization
      expect(mockDb.tableNames).toHaveBeenCalledTimes(1);
    });
  });

  describe('initializeTables', () => {
    it('should create tables if they do not exist', async () => {
      mockDb.tableNames.mockResolvedValue([]);

      await dbManager.initializeTables();

      expect(mockDb.createEmptyTable).toHaveBeenCalledTimes(3); // file, document, pr_comments
    });

    it('should open existing tables', async () => {
      // Use the correct table names from constants
      mockDb.tableNames.mockResolvedValue(['file_embeddings', 'document_chunk_embeddings', 'pr_comments']);

      await dbManager.initializeTables();

      expect(mockDb.openTable).toHaveBeenCalled();
      expect(mockDb.createEmptyTable).not.toHaveBeenCalled();
    });

    it('should handle concurrent initialization calls', async () => {
      mockDb.tableNames.mockResolvedValue([]);

      const promise1 = dbManager.initializeTables();
      const promise2 = dbManager.initializeTables();

      await Promise.all([promise1, promise2]);

      // Tables should only be created once
      expect(mockDb.tableNames).toHaveBeenCalledTimes(1);
    });
  });

  describe('getTable', () => {
    it('should return table if it exists', async () => {
      mockDb.tableNames.mockResolvedValue(['test_table']);

      const table = await dbManager.getTable('test_table');

      expect(mockDb.openTable).toHaveBeenCalledWith('test_table');
      expect(table).toBe(mockTable);
    });

    it('should return null if table does not exist', async () => {
      mockDb.tableNames.mockResolvedValue([]);

      const table = await dbManager.getTable('nonexistent');

      expect(table).toBeNull();
    });

    it('should handle errors gracefully', async () => {
      mockDb.tableNames.mockRejectedValue(new Error('DB error'));

      const table = await dbManager.getTable('test_table');

      expect(table).toBeNull();
    });
  });

  describe('createAdaptiveVectorIndexes', () => {
    it('should skip indexing for small datasets', async () => {
      mockTable.countRows.mockResolvedValue(50);

      const result = await dbManager.createAdaptiveVectorIndexes(mockTable, 'test_table', 'vector');

      expect(result.indexType).toBe('exact');
      expect(mockTable.createIndex).not.toHaveBeenCalled();
    });

    it('should use exact search for datasets under 1000 rows', async () => {
      mockTable.countRows.mockResolvedValue(500);

      const result = await dbManager.createAdaptiveVectorIndexes(mockTable, 'test_table', 'vector');

      expect(result.indexType).toBe('exact');
    });

    it('should create IVF-Flat index for medium datasets', async () => {
      mockTable.countRows.mockResolvedValue(5000);

      const result = await dbManager.createAdaptiveVectorIndexes(mockTable, 'test_table', 'vector');

      expect(result.indexType).toBe('ivf_flat');
      expect(mockTable.createIndex).toHaveBeenCalled();
    });

    it('should create IVF-PQ index for large datasets', async () => {
      mockTable.countRows.mockResolvedValue(50000);

      const result = await dbManager.createAdaptiveVectorIndexes(mockTable, 'test_table', 'vector');

      expect(result.indexType).toBe('ivf_pq');
      expect(mockTable.createIndex).toHaveBeenCalled();
    });

    it('should handle index already exists error', async () => {
      mockTable.countRows.mockResolvedValue(5000);
      mockTable.createIndex.mockRejectedValue(new Error('Index already exists'));

      const result = await dbManager.createAdaptiveVectorIndexes(mockTable, 'test_table', 'vector');

      expect(result.indexType).toBe('existing');
    });
  });

  describe('closeConnection', () => {
    it('should close database connection', async () => {
      await dbManager.getDBConnection();
      await dbManager.closeConnection();

      expect(mockDb.close).toHaveBeenCalled();
      expect(dbManager.dbConnection).toBeNull();
      expect(dbManager.tablesInitialized).toBe(false);
    });

    it('should do nothing if no connection exists', async () => {
      // Should not throw when called with no connection
      await expect(dbManager.closeConnection()).resolves.not.toThrow();
    });
  });

  describe('cleanup', () => {
    it('should close connection on cleanup', async () => {
      await dbManager.getDBConnection();
      await dbManager.cleanup();

      expect(mockDb.close).toHaveBeenCalled();
    });

    it('should prevent duplicate cleanup calls', async () => {
      await dbManager.getDBConnection();

      dbManager.cleaningUp = true;
      await dbManager.cleanup();

      // Should not close connection when already cleaning up
      expect(mockDb.close).not.toHaveBeenCalled();
    });

    it('should reset cleaningUp flag after completion', async () => {
      await dbManager.cleanup();
      expect(dbManager.cleaningUp).toBe(false);
    });
  });

  describe('clearAllEmbeddings', () => {
    it('should drop all embedding tables', async () => {
      // Use the correct table names from constants
      mockDb.tableNames.mockResolvedValue(['file_embeddings', 'document_chunk_embeddings', 'pr_comments']);

      await dbManager.clearAllEmbeddings();

      expect(mockDb.dropTable).toHaveBeenCalledTimes(3);
    });

    it('should handle non-existent database', async () => {
      fs.existsSync.mockReturnValue(false);

      const result = await dbManager.clearAllEmbeddings();

      expect(result).toBe(true);
      expect(lancedb.connect).not.toHaveBeenCalled();
    });

    it('should reset connection state after clearing', async () => {
      mockDb.tableNames.mockResolvedValue(['file_embeddings']);

      await dbManager.clearAllEmbeddings();

      expect(dbManager.dbConnection).toBeNull();
      expect(dbManager.tablesInitialized).toBe(false);
    });
  });

  describe('clearProjectEmbeddings', () => {
    it('should clear embeddings for specific project', async () => {
      mockDb.tableNames.mockResolvedValue(['file_embeddings', 'document_chunk']);

      mockTable.query.mockReturnValue({
        where: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue([{ id: 'record1', project_path: '/test/project' }]),
      });

      await dbManager.clearProjectEmbeddings('/test/project');

      expect(mockTable.delete).toHaveBeenCalled();
    });

    it('should reject invalid project paths', async () => {
      await expect(dbManager.clearProjectEmbeddings('/')).rejects.toThrow('Invalid project path');
    });

    it('should reject paths that are too shallow', async () => {
      await expect(dbManager.clearProjectEmbeddings('/home')).rejects.toThrow('Project path too generic');
    });

    it('should handle non-existent database', async () => {
      fs.existsSync.mockReturnValue(false);

      const result = await dbManager.clearProjectEmbeddings('/test/project/deep');

      expect(result).toBe(true);
    });
  });

  describe('storeProjectSummary', () => {
    it('should store project summary', async () => {
      mockDb.tableNames.mockResolvedValue(['project_summaries']);

      const summary = { technologies: ['JavaScript'], patterns: [] };
      await dbManager.storeProjectSummary('/test/project/deep', summary);

      expect(mockTable.add).toHaveBeenCalled();
    });

    it('should create table if not exists', async () => {
      mockDb.tableNames.mockResolvedValue([]);

      const summary = { technologies: [] };
      await dbManager.storeProjectSummary('/test/project/deep', summary);

      expect(mockDb.createEmptyTable).toHaveBeenCalledWith('project_summaries', expect.anything());
    });

    it('should remove existing summary before adding new one', async () => {
      mockDb.tableNames.mockResolvedValue(['project_summaries']);
      mockTable.query.mockReturnValue({
        where: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue([{ id: 'existing_summary' }]),
      });

      await dbManager.storeProjectSummary('/test/project/deep', {});

      expect(mockTable.delete).toHaveBeenCalled();
      expect(mockTable.add).toHaveBeenCalled();
    });
  });

  describe('getProjectSummary', () => {
    it('should retrieve project summary', async () => {
      mockDb.tableNames.mockResolvedValue(['project_summaries']);
      mockTable.query.mockReturnValue({
        where: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue([
          {
            id: 'summary1',
            project_path: '/test/project',
            project_name: 'project',
            summary: JSON.stringify({ technologies: ['JavaScript'] }),
            created_at: '2024-01-01T00:00:00Z',
            last_updated: '2024-01-01T00:00:00Z',
          },
        ]),
      });

      const summary = await dbManager.getProjectSummary('/test/project');

      expect(summary.technologies).toEqual(['JavaScript']);
      expect(summary._metadata).toBeDefined();
    });

    it('should return null if table does not exist', async () => {
      mockDb.tableNames.mockResolvedValue([]);

      const summary = await dbManager.getProjectSummary('/test/project');

      expect(summary).toBeNull();
    });

    it('should return null if no summary found', async () => {
      mockDb.tableNames.mockResolvedValue(['project_summaries']);
      mockTable.query.mockReturnValue({
        where: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue([]),
      });

      const summary = await dbManager.getProjectSummary('/test/project');

      expect(summary).toBeNull();
    });

    it('should return latest summary when multiple exist', async () => {
      mockDb.tableNames.mockResolvedValue(['project_summaries']);
      mockTable.query.mockReturnValue({
        where: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue([
          {
            id: 'old',
            summary: JSON.stringify({ version: 'old' }),
            last_updated: '2024-01-01T00:00:00Z',
          },
          {
            id: 'new',
            summary: JSON.stringify({ version: 'new' }),
            last_updated: '2024-12-01T00:00:00Z',
          },
        ]),
      });

      const summary = await dbManager.getProjectSummary('/test/project');

      expect(summary.version).toBe('new');
    });

    it('should handle errors gracefully', async () => {
      mockDb.tableNames.mockRejectedValue(new Error('DB error'));

      const summary = await dbManager.getProjectSummary('/test/project');

      expect(summary).toBeNull();
      expect(console.error).toHaveBeenCalled();
    });
  });

  describe('connect', () => {
    it('should call getDB', async () => {
      const db = await dbManager.connect();

      expect(db).toBe(mockDb);
      expect(dbManager.tablesInitialized).toBe(true);
    });
  });

  describe('initializeTables error handling', () => {
    it('should throw and reset state on initialization failure', async () => {
      mockDb.tableNames.mockRejectedValue(new Error('Initialization failed'));

      await expect(dbManager.initializeTables()).rejects.toThrow('Initialization failed');
      expect(dbManager.tablesInitialized).toBe(false);
      expect(console.error).toHaveBeenCalled();
    });
  });

  describe('ensureTablesExist error handling', () => {
    it('should throw on table creation error', async () => {
      mockDb.tableNames.mockResolvedValue([]);
      mockDb.createEmptyTable.mockRejectedValue(new Error('Create failed'));

      await expect(dbManager.initializeTables()).rejects.toThrow('Create failed');
    });
  });

  describe('createAdaptiveVectorIndexes edge cases', () => {
    it('should handle non-index-exists errors', async () => {
      mockTable.countRows.mockResolvedValue(5000);
      mockTable.createIndex.mockRejectedValue(new Error('Unexpected error'));

      const result = await dbManager.createAdaptiveVectorIndexes(mockTable, 'test_table', 'vector');

      expect(result.indexType).toBe('exact_fallback');
      expect(result.error).toBe('Unexpected error');
    });
  });

  describe('cleanup error handling', () => {
    it('should handle errors during cleanup', async () => {
      await dbManager.getDBConnection();
      mockDb.close.mockRejectedValue(new Error('Close failed'));

      await dbManager.cleanup();

      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Error during database cleanup'));
    });
  });

  describe('clearAllEmbeddings edge cases', () => {
    it('should handle tables that do not exist', async () => {
      mockDb.tableNames.mockResolvedValue([]);

      const result = await dbManager.clearAllEmbeddings();

      expect(result).toBe(true);
      expect(mockDb.dropTable).not.toHaveBeenCalled();
    });

    it('should handle errors during clearing', async () => {
      mockDb.tableNames.mockResolvedValue(['file_embeddings']);
      mockDb.dropTable.mockRejectedValue(new Error('Drop failed'));

      await expect(dbManager.clearAllEmbeddings()).rejects.toThrow('Drop failed');
      expect(dbManager.dbConnection).toBeNull();
      expect(dbManager.tablesInitialized).toBe(false);
    });
  });

  describe('clearProjectEmbeddings comprehensive', () => {
    it('should clear file embeddings', async () => {
      mockDb.tableNames.mockResolvedValue(['file_embeddings']);

      mockTable.query.mockReturnValue({
        toArray: vi.fn().mockResolvedValue([{ id: 'record1', project_path: '/test/project/deep' }]),
      });

      await dbManager.clearProjectEmbeddings('/test/project/deep');

      expect(mockTable.delete).toHaveBeenCalled();
    });

    it('should clear document chunk embeddings', async () => {
      mockDb.tableNames.mockResolvedValue(['document_chunk_embeddings']);

      mockTable.query.mockReturnValue({
        toArray: vi.fn().mockResolvedValue([{ id: 'doc1', project_path: '/test/project/deep' }]),
      });

      await dbManager.clearProjectEmbeddings('/test/project/deep');

      expect(mockTable.delete).toHaveBeenCalled();
    });

    it('should clear project summaries', async () => {
      mockDb.tableNames.mockResolvedValue(['project_summaries']);

      mockTable.query.mockReturnValue({
        toArray: vi.fn().mockResolvedValue([{ id: 'summary1', project_path: '/test/project/deep' }]),
      });

      await dbManager.clearProjectEmbeddings('/test/project/deep');

      expect(mockTable.delete).toHaveBeenCalled();
    });

    it('should handle project structure records', async () => {
      mockDb.tableNames.mockResolvedValue(['file_embeddings']);

      mockTable.query.mockReturnValue({
        toArray: vi.fn().mockResolvedValue([{ id: '__project_structure__deep', project_path: '/test/project/deep' }]),
      });

      await dbManager.clearProjectEmbeddings('/test/project/deep');

      expect(mockTable.delete).toHaveBeenCalled();
    });

    it('should handle no records found', async () => {
      mockDb.tableNames.mockResolvedValue(['file_embeddings']);

      mockTable.query.mockReturnValue({
        toArray: vi.fn().mockResolvedValue([]),
      });

      const result = await dbManager.clearProjectEmbeddings('/test/project/deep');

      expect(result).toBe(true);
      expect(mockTable.delete).not.toHaveBeenCalled();
    });

    it('should handle delete errors gracefully', async () => {
      mockDb.tableNames.mockResolvedValue(['file_embeddings']);

      mockTable.query.mockReturnValue({
        toArray: vi.fn().mockResolvedValue([{ id: 'record1', project_path: '/test/project/deep' }]),
      });
      mockTable.delete.mockRejectedValue(new Error('Delete failed'));

      // Should not throw, but log warning
      const result = await dbManager.clearProjectEmbeddings('/test/project/deep');

      expect(result).toBe(true);
      expect(console.warn).toHaveBeenCalled();
    });

    it('should throw on error', async () => {
      mockDb.tableNames.mockRejectedValue(new Error('DB error'));

      await expect(dbManager.clearProjectEmbeddings('/test/project/deep')).rejects.toThrow('DB error');
    });
  });

  describe('_checkSchemaCompatibility', () => {
    it('should log warning for tables without required field', async () => {
      mockTable.schema = { fields: [{ name: 'other_field' }] };
      mockDb.tableNames.mockResolvedValue(['file_embeddings']);

      await dbManager.initializeTables();

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('old schema'));
    });

    it('should handle schema check errors', async () => {
      Object.defineProperty(mockTable, 'schema', {
        get: () => {
          throw new Error('Schema error');
        },
        configurable: true,
      });
      mockDb.tableNames.mockResolvedValue(['file_embeddings']);

      // Should not throw, just log
      await dbManager.initializeTables();

      expect(dbManager.tablesInitialized).toBe(true);
    });
  });

  describe('_validateTableHasProjectPath', () => {
    it('should validate table has project_path field', async () => {
      mockTable.schema = { fields: [{ name: 'project_path' }] };

      // Access private method via clearProjectEmbeddings
      mockDb.tableNames.mockResolvedValue(['file_embeddings']);
      mockTable.query.mockReturnValue({
        toArray: vi.fn().mockResolvedValue([]),
      });

      await dbManager.clearProjectEmbeddings('/test/project/deep');

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('has project_path field'));
    });

    it('should log warning when tables without project_path field', async () => {
      // Create a schema without project_path field
      mockTable.schema = { fields: [{ name: 'other_field' }] };
      mockDb.tableNames.mockResolvedValue(['file_embeddings']);

      mockTable.query.mockReturnValue({
        toArray: vi.fn().mockResolvedValue([]),
      });

      // The validation throws inside try-catch, which logs a warning
      await dbManager.clearProjectEmbeddings('/test/project/deep');

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('does not have project_path field'));
    });

    it('should handle tables with no readable schema', async () => {
      mockTable.schema = null;
      mockDb.tableNames.mockResolvedValue(['file_embeddings']);
      mockTable.query.mockReturnValue({
        toArray: vi.fn().mockResolvedValue([]),
      });

      await dbManager.clearProjectEmbeddings('/test/project/deep');

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('no readable schema'));
    });
  });

  describe('_createFTSIndexes', () => {
    it('should handle FTS index already exists', async () => {
      mockTable.createIndex.mockRejectedValue(new Error('Index already exists'));
      mockDb.tableNames.mockResolvedValue([]);

      await dbManager.initializeTables();

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('FTS index already exists'));
    });

    it('should handle other FTS index errors', async () => {
      mockTable.createIndex.mockRejectedValue(new Error('Some other FTS error'));
      mockDb.tableNames.mockResolvedValue([]);

      await dbManager.initializeTables();

      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('FTS index warning'));
    });
  });

  describe('_optimizeTables', () => {
    it('should handle legacy format errors', async () => {
      mockTable.optimize.mockRejectedValue(new Error('legacy format detected'));

      // Access through storeProjectSummary which calls optimize
      mockDb.tableNames.mockResolvedValue(['project_summaries']);
      mockTable.query.mockReturnValue({
        where: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue([]),
      });

      await dbManager.storeProjectSummary('/test/project/deep', {});

      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('legacy index format'));
    });

    it('should handle other optimization errors', async () => {
      mockTable.optimize.mockRejectedValue(new Error('Optimization failed'));

      mockDb.tableNames.mockResolvedValue(['project_summaries']);
      mockTable.query.mockReturnValue({
        where: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue([]),
      });

      await dbManager.storeProjectSummary('/test/project/deep', {});

      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to optimize'));
    });
  });

  describe('_clearProjectTableRecords', () => {
    it('should clear records matching project path', async () => {
      mockDb.tableNames.mockResolvedValue(['file_embeddings']);
      mockTable.query.mockReturnValue({
        toArray: vi.fn().mockResolvedValue([{ id: 'record1', project_path: '/test/project/deep' }]),
      });

      await dbManager.clearProjectEmbeddings('/test/project/deep');

      expect(mockTable.delete).toHaveBeenCalledWith(expect.stringContaining('record1'));
    });

    it('should handle relative paths for non-project_path fields', async () => {
      mockDb.tableNames.mockResolvedValue(['file_embeddings']);
      mockTable.query.mockReturnValue({
        toArray: vi.fn().mockResolvedValue([{ id: 'record1', project_path: '/test/project/deep', path: 'src/file.js' }]),
      });

      await dbManager.clearProjectEmbeddings('/test/project/deep');

      expect(mockTable.delete).toHaveBeenCalled();
    });
  });

  describe('updatePRCommentsIndex', () => {
    it('should update vector index for PR comments table', async () => {
      mockDb.tableNames.mockResolvedValue(['pr_comments']);
      mockTable.countRows.mockResolvedValue(5000);

      await dbManager.updatePRCommentsIndex();

      expect(mockTable.createIndex).toHaveBeenCalled();
      expect(mockTable.optimize).toHaveBeenCalled();
    });

    it('should handle legacy format during optimization', async () => {
      mockDb.tableNames.mockResolvedValue(['pr_comments']);
      mockTable.countRows.mockResolvedValue(100);
      mockTable.optimize.mockRejectedValue(new Error('legacy format'));

      await dbManager.updatePRCommentsIndex();

      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('legacy index format'));
    });

    it('should throw on non-legacy optimization errors', async () => {
      mockDb.tableNames.mockResolvedValue(['pr_comments']);
      mockTable.countRows.mockResolvedValue(100);
      mockTable.optimize.mockRejectedValue(new Error('Critical error'));

      await expect(dbManager.updatePRCommentsIndex()).rejects.toThrow('Failed to update PR comments index');
    });

    it('should handle table not found', async () => {
      mockDb.tableNames.mockResolvedValue([]);

      await dbManager.updatePRCommentsIndex();

      // Should not throw, table is optional
      expect(mockTable.createIndex).not.toHaveBeenCalled();
    });
  });

  describe('storeProjectSummary error handling', () => {
    it('should handle delete errors gracefully', async () => {
      mockDb.tableNames.mockResolvedValue(['project_summaries']);
      mockTable.query.mockReturnValue({
        where: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockRejectedValue(new Error('Query failed')),
      });

      // Should continue to add despite query failure
      await dbManager.storeProjectSummary('/test/project/deep', {});

      expect(mockTable.add).toHaveBeenCalled();
    });

    it('should throw on add error', async () => {
      mockDb.tableNames.mockResolvedValue(['project_summaries']);
      mockTable.query.mockReturnValue({
        where: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue([]),
      });
      mockTable.add.mockRejectedValue(new Error('Add failed'));

      await expect(dbManager.storeProjectSummary('/test/project/deep', {})).rejects.toThrow('Failed to store project summary');
    });
  });

  describe('_optimizeTablesAfterCleanup', () => {
    it('should optimize tables after cleanup', async () => {
      mockDb.tableNames.mockResolvedValue(['file_embeddings', 'document_chunk_embeddings']);
      mockTable.query.mockReturnValue({
        toArray: vi.fn().mockResolvedValue([{ id: 'record1', project_path: '/test/project/deep' }]),
      });

      await dbManager.clearProjectEmbeddings('/test/project/deep');

      expect(mockTable.optimize).toHaveBeenCalled();
    });

    it('should handle legacy format during post-cleanup optimization', async () => {
      mockDb.tableNames.mockResolvedValue(['file_embeddings']);
      mockTable.query.mockReturnValue({
        toArray: vi.fn().mockResolvedValue([{ id: 'record1', project_path: '/test/project/deep' }]),
      });
      mockTable.optimize.mockRejectedValue(new Error('legacy format'));

      await dbManager.clearProjectEmbeddings('/test/project/deep');

      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('legacy index format'));
    });

    it('should handle other optimization errors after cleanup', async () => {
      mockDb.tableNames.mockResolvedValue(['file_embeddings']);
      mockTable.query.mockReturnValue({
        toArray: vi.fn().mockResolvedValue([{ id: 'record1', project_path: '/test/project/deep' }]),
      });
      mockTable.optimize.mockRejectedValue(new Error('Other error'));

      await dbManager.clearProjectEmbeddings('/test/project/deep');

      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to optimize'));
    });
  });

  describe('createPRCommentsSchema', () => {
    it('should create schema with correct fields', () => {
      const schema = dbManager.createPRCommentsSchema();

      expect(schema).toBeDefined();
      expect(schema.fields).toBeDefined();
      expect(schema.fields.length).toBeGreaterThan(0);
    });
  });
});
