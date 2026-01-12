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
    default: { ...original, existsSync: vi.fn(), mkdirSync: vi.fn() },
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

// ============================================================================
// Helpers
// ============================================================================

const createMockTable = (overrides = {}) => ({
  countRows: vi.fn().mockResolvedValue(50),
  createIndex: vi.fn().mockResolvedValue(undefined),
  schema: { fields: [{ name: 'project_path' }] },
  query: vi.fn().mockReturnValue({ where: vi.fn().mockReturnThis(), toArray: vi.fn().mockResolvedValue([]) }),
  add: vi.fn().mockResolvedValue(undefined),
  delete: vi.fn().mockResolvedValue(undefined),
  optimize: vi.fn().mockResolvedValue(undefined),
  ...overrides,
});

const createMockDb = (mockTable) => ({
  tableNames: vi.fn().mockResolvedValue([]),
  createEmptyTable: vi.fn().mockResolvedValue(mockTable),
  openTable: vi.fn().mockResolvedValue(mockTable),
  dropTable: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
});

// ============================================================================
// Tests
// ============================================================================

describe('DatabaseManager', () => {
  let dbManager;
  let mockDb;
  let mockTable;

  beforeEach(() => {
    mockConsole();
    mockTable = createMockTable();
    mockDb = createMockDb(mockTable);
    lancedb.connect.mockResolvedValue(mockDb);
    fs.existsSync.mockReturnValue(true);
    dbManager = new DatabaseManager({ dbPath: '/test/db/path', embeddingDimensions: 384 });
  });

  // ==========================================================================
  // Constructor
  // ==========================================================================

  describe('constructor', () => {
    it.each([
      ['default', {}, { dim: 384, conn: null }],
      ['custom', { dbPath: '/custom', embeddingDimensions: 768 }, { path: '/custom', dim: 768 }],
    ])('should initialize with %s options', (_, opts, expected) => {
      const manager = new DatabaseManager(opts);
      if (expected.dim) expect(manager.embeddingDimensions).toBe(expected.dim);
      if (expected.conn !== undefined) expect(manager.dbConnection).toBeNull();
      if (expected.path) expect(manager.dbPath).toBe(expected.path);
    });
  });

  // ==========================================================================
  // Connection Management
  // ==========================================================================

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
      expect(await dbManager.getDB()).toBe(mockDb);
      expect(dbManager.tablesInitialized).toBe(true);
    });

    it('should not reinitialize tables on subsequent calls', async () => {
      await dbManager.getDB();
      await dbManager.getDB();
      expect(mockDb.tableNames).toHaveBeenCalledTimes(1);
    });
  });

  describe('connect', () => {
    it('should call getDB', async () => {
      expect(await dbManager.connect()).toBe(mockDb);
      expect(dbManager.tablesInitialized).toBe(true);
    });
  });

  describe('closeConnection', () => {
    it('should close database connection', async () => {
      await dbManager.getDBConnection();
      await dbManager.closeConnection();
      expect(mockDb.close).toHaveBeenCalled();
      expect(dbManager.dbConnection).toBeNull();
    });

    it('should do nothing if no connection exists', async () => {
      await expect(dbManager.closeConnection()).resolves.not.toThrow();
    });
  });

  // ==========================================================================
  // Table Initialization
  // ==========================================================================

  describe('initializeTables', () => {
    it('should create tables if they do not exist', async () => {
      mockDb.tableNames.mockResolvedValue([]);
      await dbManager.initializeTables();
      expect(mockDb.createEmptyTable).toHaveBeenCalledTimes(3);
    });

    it('should open existing tables', async () => {
      mockDb.tableNames.mockResolvedValue(['file_embeddings', 'document_chunk_embeddings', 'pr_comments']);
      await dbManager.initializeTables();
      expect(mockDb.openTable).toHaveBeenCalled();
      expect(mockDb.createEmptyTable).not.toHaveBeenCalled();
    });

    it('should handle concurrent initialization calls', async () => {
      mockDb.tableNames.mockResolvedValue([]);
      await Promise.all([dbManager.initializeTables(), dbManager.initializeTables()]);
      expect(mockDb.tableNames).toHaveBeenCalledTimes(1);
    });

    it('should throw and reset state on initialization failure', async () => {
      mockDb.tableNames.mockRejectedValue(new Error('Initialization failed'));
      await expect(dbManager.initializeTables()).rejects.toThrow('Initialization failed');
      expect(dbManager.tablesInitialized).toBe(false);
    });

    it('should throw on table creation error', async () => {
      mockDb.tableNames.mockResolvedValue([]);
      mockDb.createEmptyTable.mockRejectedValue(new Error('Create failed'));
      await expect(dbManager.initializeTables()).rejects.toThrow('Create failed');
    });
  });

  // ==========================================================================
  // getTable
  // ==========================================================================

  describe('getTable', () => {
    it.each([
      ['existing', ['test_table'], (t) => t === mockTable],
      ['non-existent', [], (t) => t === null],
    ])('should handle %s table', async (_, tables, validator) => {
      mockDb.tableNames.mockResolvedValue(tables);
      const table = await dbManager.getTable('test_table');
      expect(validator(table)).toBe(true);
    });

    it('should handle errors gracefully', async () => {
      mockDb.tableNames.mockRejectedValue(new Error('DB error'));
      expect(await dbManager.getTable('test_table')).toBeNull();
    });
  });

  // ==========================================================================
  // Adaptive Vector Indexes
  // ==========================================================================

  describe('createAdaptiveVectorIndexes', () => {
    it.each([
      [50, 'exact', false],
      [500, 'exact', false],
      [5000, 'ivf_flat', true],
      [50000, 'ivf_pq', true],
    ])('should use %s index for %i rows', async (rows, expectedType, shouldCreate) => {
      mockTable.countRows.mockResolvedValue(rows);
      const result = await dbManager.createAdaptiveVectorIndexes(mockTable, 'test', 'vector');
      expect(result.indexType).toBe(expectedType);
      if (shouldCreate) expect(mockTable.createIndex).toHaveBeenCalled();
      else expect(mockTable.createIndex).not.toHaveBeenCalled();
    });

    it('should handle index already exists error', async () => {
      mockTable.countRows.mockResolvedValue(5000);
      mockTable.createIndex.mockRejectedValue(new Error('Index already exists'));
      expect((await dbManager.createAdaptiveVectorIndexes(mockTable, 'test', 'vector')).indexType).toBe('existing');
    });

    it('should handle non-index-exists errors', async () => {
      mockTable.countRows.mockResolvedValue(5000);
      mockTable.createIndex.mockRejectedValue(new Error('Unexpected error'));
      const result = await dbManager.createAdaptiveVectorIndexes(mockTable, 'test', 'vector');
      expect(result.indexType).toBe('exact_fallback');
      expect(result.error).toBe('Unexpected error');
    });
  });

  // ==========================================================================
  // Cleanup
  // ==========================================================================

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
      expect(mockDb.close).not.toHaveBeenCalled();
    });

    it('should reset cleaningUp flag after completion', async () => {
      await dbManager.cleanup();
      expect(dbManager.cleaningUp).toBe(false);
    });

    it('should handle errors during cleanup', async () => {
      await dbManager.getDBConnection();
      mockDb.close.mockRejectedValue(new Error('Close failed'));
      await dbManager.cleanup();
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Error during database cleanup'));
    });
  });

  // ==========================================================================
  // Clear All Embeddings
  // ==========================================================================

  describe('clearAllEmbeddings', () => {
    it('should drop all embedding tables', async () => {
      mockDb.tableNames.mockResolvedValue(['file_embeddings', 'document_chunk_embeddings', 'pr_comments']);
      await dbManager.clearAllEmbeddings();
      expect(mockDb.dropTable).toHaveBeenCalledTimes(3);
    });

    it('should handle non-existent database', async () => {
      fs.existsSync.mockReturnValue(false);
      expect(await dbManager.clearAllEmbeddings()).toBe(true);
      expect(lancedb.connect).not.toHaveBeenCalled();
    });

    it('should reset connection state after clearing', async () => {
      mockDb.tableNames.mockResolvedValue(['file_embeddings']);
      await dbManager.clearAllEmbeddings();
      expect(dbManager.dbConnection).toBeNull();
      expect(dbManager.tablesInitialized).toBe(false);
    });

    it('should handle tables that do not exist', async () => {
      mockDb.tableNames.mockResolvedValue([]);
      expect(await dbManager.clearAllEmbeddings()).toBe(true);
      expect(mockDb.dropTable).not.toHaveBeenCalled();
    });

    it('should handle errors during clearing', async () => {
      mockDb.tableNames.mockResolvedValue(['file_embeddings']);
      mockDb.dropTable.mockRejectedValue(new Error('Drop failed'));
      await expect(dbManager.clearAllEmbeddings()).rejects.toThrow('Drop failed');
      expect(dbManager.tablesInitialized).toBe(false);
    });
  });

  // ==========================================================================
  // Clear Project Embeddings
  // ==========================================================================

  describe('clearProjectEmbeddings', () => {
    const setupQuery = (records) => mockTable.query.mockReturnValue({ toArray: vi.fn().mockResolvedValue(records) });

    it.each([
      ['/', 'Invalid project path'],
      ['/home', 'Project path too generic'],
    ])('should reject %s with "%s"', async (path, error) => {
      await expect(dbManager.clearProjectEmbeddings(path)).rejects.toThrow(error);
    });

    it('should clear embeddings for specific project', async () => {
      mockDb.tableNames.mockResolvedValue(['file_embeddings']);
      mockTable.query.mockReturnValue({
        where: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue([{ id: 'record1', project_path: '/test/project' }]),
      });
      await dbManager.clearProjectEmbeddings('/test/project');
      expect(mockTable.delete).toHaveBeenCalled();
    });

    it('should handle non-existent database', async () => {
      fs.existsSync.mockReturnValue(false);
      expect(await dbManager.clearProjectEmbeddings('/test/project/deep')).toBe(true);
    });

    it.each([
      ['file embeddings', 'file_embeddings'],
      ['document chunk embeddings', 'document_chunk_embeddings'],
      ['project summaries', 'project_summaries'],
    ])('should clear %s', async (_, tableName) => {
      mockDb.tableNames.mockResolvedValue([tableName]);
      setupQuery([{ id: 'rec1', project_path: '/test/project/deep' }]);
      await dbManager.clearProjectEmbeddings('/test/project/deep');
      expect(mockTable.delete).toHaveBeenCalled();
    });

    it('should handle no records found', async () => {
      mockDb.tableNames.mockResolvedValue(['file_embeddings']);
      setupQuery([]);
      expect(await dbManager.clearProjectEmbeddings('/test/project/deep')).toBe(true);
      expect(mockTable.delete).not.toHaveBeenCalled();
    });

    it('should handle delete errors gracefully', async () => {
      mockDb.tableNames.mockResolvedValue(['file_embeddings']);
      setupQuery([{ id: 'record1', project_path: '/test/project/deep' }]);
      mockTable.delete.mockRejectedValue(new Error('Delete failed'));
      expect(await dbManager.clearProjectEmbeddings('/test/project/deep')).toBe(true);
      expect(console.warn).toHaveBeenCalled();
    });

    it('should throw on error', async () => {
      mockDb.tableNames.mockRejectedValue(new Error('DB error'));
      await expect(dbManager.clearProjectEmbeddings('/test/project/deep')).rejects.toThrow('DB error');
    });
  });

  // ==========================================================================
  // Project Summary
  // ==========================================================================

  describe('storeProjectSummary', () => {
    const mockQuery = (records = []) =>
      mockTable.query.mockReturnValue({
        where: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue(records),
      });

    it('should store project summary', async () => {
      mockDb.tableNames.mockResolvedValue(['project_summaries']);
      mockQuery();
      await dbManager.storeProjectSummary('/test/project/deep', { technologies: ['JavaScript'] });
      expect(mockTable.add).toHaveBeenCalled();
    });

    it('should create table if not exists', async () => {
      mockDb.tableNames.mockResolvedValue([]);
      mockQuery();
      await dbManager.storeProjectSummary('/test/project/deep', {});
      expect(mockDb.createEmptyTable).toHaveBeenCalledWith('project_summaries', expect.anything());
    });

    it('should remove existing summary before adding new one', async () => {
      mockDb.tableNames.mockResolvedValue(['project_summaries']);
      mockQuery([{ id: 'existing_summary' }]);
      await dbManager.storeProjectSummary('/test/project/deep', {});
      expect(mockTable.delete).toHaveBeenCalled();
      expect(mockTable.add).toHaveBeenCalled();
    });

    it('should handle delete errors gracefully', async () => {
      mockDb.tableNames.mockResolvedValue(['project_summaries']);
      mockTable.query.mockReturnValue({
        where: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockRejectedValue(new Error('Query failed')),
      });
      await dbManager.storeProjectSummary('/test/project/deep', {});
      expect(mockTable.add).toHaveBeenCalled();
    });

    it('should throw on add error', async () => {
      mockDb.tableNames.mockResolvedValue(['project_summaries']);
      mockQuery();
      mockTable.add.mockRejectedValue(new Error('Add failed'));
      await expect(dbManager.storeProjectSummary('/test/project/deep', {})).rejects.toThrow('Failed to store project summary');
    });
  });

  describe('getProjectSummary', () => {
    const mockQuery = (records = []) =>
      mockTable.query.mockReturnValue({
        where: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue(records),
      });

    it('should retrieve project summary', async () => {
      mockDb.tableNames.mockResolvedValue(['project_summaries']);
      mockQuery([
        {
          id: 'summary1',
          project_path: '/test/project',
          project_name: 'project',
          summary: JSON.stringify({ technologies: ['JavaScript'] }),
          created_at: '2024-01-01T00:00:00Z',
          last_updated: '2024-01-01T00:00:00Z',
        },
      ]);
      const summary = await dbManager.getProjectSummary('/test/project');
      expect(summary.technologies).toEqual(['JavaScript']);
      expect(summary._metadata).toBeDefined();
    });

    it.each([
      ['table does not exist', [], []],
      ['no summary found', ['project_summaries'], []],
    ])('should return null if %s', async (_, tables, records) => {
      mockDb.tableNames.mockResolvedValue(tables);
      if (tables.length) mockQuery(records);
      expect(await dbManager.getProjectSummary('/test/project')).toBeNull();
    });

    it('should return latest summary when multiple exist', async () => {
      mockDb.tableNames.mockResolvedValue(['project_summaries']);
      mockQuery([
        { id: 'old', summary: JSON.stringify({ version: 'old' }), last_updated: '2024-01-01T00:00:00Z' },
        { id: 'new', summary: JSON.stringify({ version: 'new' }), last_updated: '2024-12-01T00:00:00Z' },
      ]);
      expect((await dbManager.getProjectSummary('/test/project')).version).toBe('new');
    });

    it('should handle errors gracefully', async () => {
      mockDb.tableNames.mockRejectedValue(new Error('DB error'));
      expect(await dbManager.getProjectSummary('/test/project')).toBeNull();
      expect(console.error).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // PR Comments Index
  // ==========================================================================

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
      expect(mockTable.createIndex).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Schema Checks
  // ==========================================================================

  describe('schema compatibility', () => {
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
      await dbManager.initializeTables();
      expect(dbManager.tablesInitialized).toBe(true);
    });
  });

  describe('validateTableHasProjectPath', () => {
    it.each([
      ['has project_path field', { fields: [{ name: 'project_path' }] }, 'has project_path field'],
      ['does not have project_path field', { fields: [{ name: 'other' }] }, 'does not have project_path'],
      ['no readable schema', null, 'no readable schema'],
    ])('should log when table %s', async (_, schema, expectedLog) => {
      mockTable.schema = schema;
      mockDb.tableNames.mockResolvedValue(['file_embeddings']);
      mockTable.query.mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) });
      await dbManager.clearProjectEmbeddings('/test/project/deep');
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining(expectedLog));
    });
  });

  // ==========================================================================
  // FTS Indexes
  // ==========================================================================

  describe('FTS indexes', () => {
    it.each([
      ['already exists', 'Index already exists', 'FTS index already exists'],
      ['other error', 'Some other FTS error', 'FTS index warning'],
    ])('should handle FTS index %s', async (_, error, expectedLog) => {
      mockTable.createIndex.mockRejectedValue(new Error(error));
      mockDb.tableNames.mockResolvedValue([]);
      await dbManager.initializeTables();
      if (error.includes('already')) {
        expect(console.log).toHaveBeenCalledWith(expect.stringContaining(expectedLog));
      } else {
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(expectedLog));
      }
    });
  });

  // ==========================================================================
  // Optimization
  // ==========================================================================

  describe('table optimization', () => {
    it.each([
      ['legacy format', 'legacy format detected', 'legacy index format'],
      ['other error', 'Optimization failed', 'Failed to optimize'],
    ])('should handle %s during optimization', async (_, error, expectedLog) => {
      mockTable.optimize.mockRejectedValue(new Error(error));
      mockDb.tableNames.mockResolvedValue(['project_summaries']);
      mockTable.query.mockReturnValue({ where: vi.fn().mockReturnThis(), toArray: vi.fn().mockResolvedValue([]) });
      await dbManager.storeProjectSummary('/test/project/deep', {});
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(expectedLog));
    });
  });

  describe('optimization after cleanup', () => {
    const setupCleanup = (records) => {
      mockDb.tableNames.mockResolvedValue(['file_embeddings']);
      mockTable.query.mockReturnValue({ toArray: vi.fn().mockResolvedValue(records) });
    };

    it('should optimize tables after cleanup', async () => {
      setupCleanup([{ id: 'record1', project_path: '/test/project/deep' }]);
      await dbManager.clearProjectEmbeddings('/test/project/deep');
      expect(mockTable.optimize).toHaveBeenCalled();
    });

    it.each([
      ['legacy format', 'legacy format', 'legacy index format'],
      ['other error', 'Other error', 'Failed to optimize'],
    ])('should handle %s during post-cleanup optimization', async (_, error, expectedLog) => {
      setupCleanup([{ id: 'record1', project_path: '/test/project/deep' }]);
      mockTable.optimize.mockRejectedValue(new Error(error));
      await dbManager.clearProjectEmbeddings('/test/project/deep');
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(expectedLog));
    });
  });

  // ==========================================================================
  // Schema
  // ==========================================================================

  describe('createPRCommentsSchema', () => {
    it('should create schema with correct fields', () => {
      const schema = dbManager.createPRCommentsSchema();
      expect(schema).toBeDefined();
      expect(schema.fields).toBeDefined();
      expect(schema.fields.length).toBeGreaterThan(0);
    });
  });
});
