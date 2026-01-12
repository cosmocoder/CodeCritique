import { getDefaultEmbeddingsSystem } from './factory.js';

vi.mock('./cache-manager.js', () => ({
  CacheManager: class {
    getCacheMetrics = vi.fn().mockReturnValue({ sizes: {}, limits: {}, statistics: {} });
    getCacheStatus = vi.fn().mockReturnValue({ totalCachedItems: 0 });
    cleanup = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock('./database.js', () => ({
  DatabaseManager: class {
    initializeTables = vi.fn().mockResolvedValue(undefined);
    getDBConnection = vi.fn().mockResolvedValue({});
    getTable = vi.fn().mockResolvedValue({});
    clearProjectEmbeddings = vi.fn().mockResolvedValue(true);
    clearAllEmbeddings = vi.fn().mockResolvedValue(true);
    storeProjectSummary = vi.fn().mockResolvedValue(true);
    getProjectSummary = vi.fn().mockResolvedValue(null);
    updatePRCommentsIndex = vi.fn().mockResolvedValue(undefined);
    cleanup = vi.fn().mockResolvedValue(undefined);
    tablesInitialized = true;
    prCommentsTable = 'pr_comments';
  },
}));

vi.mock('./model-manager.js', () => ({
  ModelManager: class {
    initialize = vi.fn().mockResolvedValue({});
    calculateEmbedding = vi.fn().mockResolvedValue(createMockEmbedding());
    calculateQueryEmbedding = vi.fn().mockResolvedValue(createMockEmbedding());
    isInitialized = vi.fn().mockReturnValue(true);
    cleanup = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock('./file-processor.js', () => ({
  FileProcessor: class {
    processBatchEmbeddings = vi.fn().mockResolvedValue({ processed: 0 });
    cleanup = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock('../content-retrieval.js', () => ({
  ContentRetriever: class {
    findRelevantDocs = vi.fn().mockResolvedValue([]);
    findSimilarCode = vi.fn().mockResolvedValue([]);
    getPerformanceMetrics = vi.fn().mockReturnValue({ searchCount: 0 });
    cleanup = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock('../custom-documents.js', () => ({
  CustomDocumentProcessor: class {
    processDocumentsInMemory = vi.fn().mockResolvedValue([]);
    findRelevantChunks = vi.fn().mockResolvedValue([]);
    getExistingChunks = vi.fn().mockResolvedValue([]);
    getPerformanceMetrics = vi.fn().mockReturnValue({ documentsProcessed: 0 });
    cleanup = vi.fn().mockResolvedValue(undefined);
  },
}));

describe('EmbeddingsSystem', () => {
  let system;

  beforeEach(() => {
    mockConsoleSelective('log', 'error');

    // Get fresh system instance
    system = getDefaultEmbeddingsSystem();
    // Reset all state for clean tests
    system.initialized = false;
    system.initializing = false;
    system.initializationPromise = null;
    system.cleaningUp = false;
  });

  describe('getDefaultEmbeddingsSystem', () => {
    it('should return the same singleton instance', () => {
      const system1 = getDefaultEmbeddingsSystem();
      const system2 = getDefaultEmbeddingsSystem();
      expect(system1).toBe(system2);
    });

    it('should create system with all components', () => {
      expect(system.cacheManager).toBeDefined();
      expect(system.databaseManager).toBeDefined();
      expect(system.modelManager).toBeDefined();
      expect(system.fileProcessor).toBeDefined();
      expect(system.contentRetriever).toBeDefined();
      expect(system.customDocumentProcessor).toBeDefined();
    });
  });

  describe('initialize', () => {
    it('should initialize database and model', async () => {
      await system.initialize();

      expect(system.databaseManager.initializeTables).toHaveBeenCalled();
      expect(system.modelManager.initialize).toHaveBeenCalled();
      expect(system.initialized).toBe(true);
    });

    it('should not reinitialize if already initialized', async () => {
      await system.initialize();
      await system.initialize();

      expect(system.databaseManager.initializeTables).toHaveBeenCalledTimes(1);
    });

    it('should handle concurrent initialization calls', async () => {
      const promise1 = system.initialize();
      const promise2 = system.initialize();

      await Promise.all([promise1, promise2]);

      expect(system.databaseManager.initializeTables).toHaveBeenCalledTimes(1);
    });

    it('should set initializing flag during initialization', async () => {
      const initPromise = system.initialize();
      expect(system.initializing).toBe(true);

      await initPromise;
      expect(system.initializing).toBe(false);
    });
  });

  describe('isInitialized', () => {
    it('should return false before initialization', () => {
      expect(system.isInitialized()).toBe(false);
    });

    it('should return true after initialization', async () => {
      await system.initialize();
      expect(system.isInitialized()).toBe(true);
    });
  });

  describe('calculateEmbedding', () => {
    it('should initialize and delegate to model manager', async () => {
      const result = await system.calculateEmbedding('test text');

      expect(system.modelManager.calculateEmbedding).toHaveBeenCalledWith('test text');
      expect(result).toBeDefined();
    });
  });

  describe('calculateQueryEmbedding', () => {
    it('should initialize and delegate to model manager', async () => {
      const result = await system.calculateQueryEmbedding('query text');

      expect(system.modelManager.calculateQueryEmbedding).toHaveBeenCalledWith('query text');
      expect(result).toBeDefined();
    });
  });

  describe('findRelevantDocs', () => {
    it('should initialize and delegate to content retriever', async () => {
      const options = { limit: 5 };
      await system.findRelevantDocs('search query', options);

      expect(system.contentRetriever.findRelevantDocs).toHaveBeenCalledWith('search query', options);
    });
  });

  describe('findSimilarCode', () => {
    it('should initialize and delegate to content retriever', async () => {
      const options = { limit: 10 };
      await system.findSimilarCode('code query', options);

      expect(system.contentRetriever.findSimilarCode).toHaveBeenCalledWith('code query', options);
    });
  });

  describe('processCustomDocumentsInMemory', () => {
    it('should initialize and delegate to custom document processor', async () => {
      const docs = [{ title: 'Doc', content: 'Content' }];
      await system.processCustomDocumentsInMemory(docs, '/project');

      expect(system.customDocumentProcessor.processDocumentsInMemory).toHaveBeenCalledWith(docs, '/project');
    });
  });

  describe('findRelevantCustomDocChunks', () => {
    it('should initialize and delegate to custom document processor', async () => {
      const chunks = [{ id: 'chunk1' }];
      const options = { limit: 5 };
      await system.findRelevantCustomDocChunks('query', chunks, options);

      expect(system.customDocumentProcessor.findRelevantChunks).toHaveBeenCalledWith('query', chunks, options);
    });
  });

  describe('getExistingCustomDocumentChunks', () => {
    it('should initialize and delegate to custom document processor', async () => {
      await system.getExistingCustomDocumentChunks('/project');

      expect(system.customDocumentProcessor.getExistingChunks).toHaveBeenCalledWith('/project');
    });
  });

  describe('processBatchEmbeddings', () => {
    it('should initialize and delegate to file processor', async () => {
      const filePaths = ['file1.js', 'file2.js'];
      const options = { projectPath: '/project' };
      await system.processBatchEmbeddings(filePaths, options);

      expect(system.fileProcessor.processBatchEmbeddings).toHaveBeenCalledWith(filePaths, options);
    });
  });

  describe('clearEmbeddings', () => {
    it('should get connection and delegate to database manager', async () => {
      await system.clearEmbeddings('/project');

      expect(system.databaseManager.getDBConnection).toHaveBeenCalled();
      expect(system.databaseManager.clearProjectEmbeddings).toHaveBeenCalledWith('/project');
    });
  });

  describe('clearAllEmbeddings', () => {
    it('should get connection and delegate to database manager', async () => {
      await system.clearAllEmbeddings();

      expect(system.databaseManager.getDBConnection).toHaveBeenCalled();
      expect(system.databaseManager.clearAllEmbeddings).toHaveBeenCalled();
    });
  });

  describe('storeProjectSummary', () => {
    it('should delegate to database manager', async () => {
      const summary = { technologies: ['JavaScript'] };
      await system.storeProjectSummary('/project', summary);

      expect(system.databaseManager.storeProjectSummary).toHaveBeenCalledWith('/project', summary);
    });
  });

  describe('getProjectSummary', () => {
    it('should delegate to database manager', async () => {
      await system.getProjectSummary('/project');

      expect(system.databaseManager.getProjectSummary).toHaveBeenCalledWith('/project');
    });
  });

  describe('getPRCommentsTable', () => {
    it('should initialize and get PR comments table', async () => {
      await system.getPRCommentsTable();

      expect(system.databaseManager.getTable).toHaveBeenCalledWith('pr_comments');
    });
  });

  describe('updatePRCommentsIndex', () => {
    it('should initialize and update PR comments index', async () => {
      await system.updatePRCommentsIndex();

      expect(system.databaseManager.updatePRCommentsIndex).toHaveBeenCalled();
    });
  });

  describe('getSystemMetrics', () => {
    it('should return metrics from all components', () => {
      const metrics = system.getSystemMetrics();

      expect(metrics.initialized).toBeDefined();
      expect(metrics.cacheMetrics).toBeDefined();
      expect(metrics.contentRetrieverMetrics).toBeDefined();
      expect(metrics.customDocumentMetrics).toBeDefined();
    });
  });

  describe('getSystemStatus', () => {
    it('should return status from all components', () => {
      const status = system.getSystemStatus();

      expect(status.initialized).toBeDefined();
      expect(status.initializing).toBeDefined();
      expect(status.modelReady).toBeDefined();
      expect(status.databaseReady).toBeDefined();
      expect(status.cacheStatus).toBeDefined();
    });
  });

  describe('getProjectEmbeddings', () => {
    it('should return project embeddings info', () => {
      const result = system.getProjectEmbeddings('/project');

      expect(result.system).toBe(system);
      expect(result.projectPath).toBe('/project');
      expect(result.components).toBeDefined();
    });
  });

  describe('cleanup', () => {
    it('should cleanup all components', async () => {
      await system.cleanup();

      expect(system.modelManager.cleanup).toHaveBeenCalled();
      expect(system.databaseManager.cleanup).toHaveBeenCalled();
      expect(system.fileProcessor.cleanup).toHaveBeenCalled();
      expect(system.contentRetriever.cleanup).toHaveBeenCalled();
      expect(system.customDocumentProcessor.cleanup).toHaveBeenCalled();
      expect(system.cacheManager.cleanup).toHaveBeenCalled();
    });

    it('should reset initialization state', async () => {
      await system.initialize();
      await system.cleanup();

      expect(system.initialized).toBe(false);
      expect(system.initializing).toBe(false);
    });

    it('should prevent duplicate cleanup calls', async () => {
      system.cleaningUp = true;
      await system.cleanup();

      expect(system.modelManager.cleanup).not.toHaveBeenCalled();
    });

    it('should reset cleaningUp flag after completion', async () => {
      await system.cleanup();
      expect(system.cleaningUp).toBe(false);
    });
  });
});
