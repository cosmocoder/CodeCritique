/**
 * Shared test fixtures and mock factories
 * Centralizes common mock objects used across multiple test files
 *
 * Type imports from source files - changes there will cause type errors here
 * @typedef {import('../embeddings/factory.js').EmbeddingsSystem} EmbeddingsSystem
 * @typedef {import('../embeddings/database.js').DatabaseManager} DatabaseManager
 * @typedef {import('../embeddings/model-manager.js').ModelManager} ModelManager
 * @typedef {import('../embeddings/types.js').SearchResult} SearchResult
 * @typedef {import('../embeddings/types.js').DocumentChunk} DocumentChunk
 * @typedef {import('@lancedb/lancedb').Table} LanceDBTable
 */

// ============================================================================
// Mock Table Factory
// ============================================================================

/**
 * Creates a mock LanceDB table with chainable query methods
 * @param {Partial<LanceDBTable>} overrides - Properties to override in the mock table
 * @returns {LanceDBTable} Mock table object
 */
export function createMockTable(overrides = {}) {
  const table = {
    add: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    optimize: vi.fn().mockResolvedValue(undefined),
    countRows: vi.fn().mockResolvedValue(0),
    createIndex: vi.fn().mockResolvedValue(undefined),
    schema: { fields: [{ name: 'project_path' }] },
    query: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      toArray: vi.fn().mockResolvedValue([]),
    }),
    search: vi.fn().mockReturnValue({
      column: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      toArray: vi.fn().mockResolvedValue([]),
    }),
    ...overrides,
  };
  return table;
}

// ============================================================================
// Mock Database Manager Factory
// ============================================================================

/**
 * Creates a mock database manager with common methods
 * Based on src/embeddings/database.js DatabaseManager class
 * @param {LanceDBTable|null} mockTable - Optional mock table to use
 * @returns {DatabaseManager} Mock database manager
 */
export function createMockDatabaseManager(mockTable = null) {
  const table = mockTable || createMockTable();
  return /** @type {DatabaseManager} */ ({
    // Connection methods
    connect: vi.fn().mockResolvedValue({}),
    getDB: vi.fn().mockResolvedValue({}),
    getDBConnection: vi.fn().mockResolvedValue({}),
    getTable: vi.fn().mockResolvedValue(table),
    closeConnection: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn().mockResolvedValue(undefined),
    // Table initialization
    initializeTables: vi.fn().mockResolvedValue(undefined),
    ensureTablesExist: vi.fn().mockResolvedValue(undefined),
    // Embeddings operations
    clearAllEmbeddings: vi.fn().mockResolvedValue(true),
    clearProjectEmbeddings: vi.fn().mockResolvedValue(true),
    // Project summary
    storeProjectSummary: vi.fn().mockResolvedValue(undefined),
    getProjectSummary: vi.fn().mockResolvedValue(null),
    // PR comments
    updatePRCommentsIndex: vi.fn().mockResolvedValue(undefined),
    createPRCommentsSchema: vi.fn().mockReturnValue({ fields: [] }),
    // Indexing
    createAdaptiveVectorIndexes: vi.fn().mockResolvedValue({ indexType: 'exact' }),
    // State
    tablesInitialized: false,
    dbConnection: null,
    embeddingDimensions: 384,
  });
}

// ============================================================================
// Mock Model Manager Factory
// ============================================================================

/**
 * Creates a mock model manager for embedding operations
 * Based on src/embeddings/model-manager.js ModelManager class
 * @param {Partial<ModelManager>} overrides - Properties to override
 * @returns {ModelManager} Mock model manager
 */
export function createMockModelManager(overrides = {}) {
  return /** @type {ModelManager} */ ({
    // Lifecycle
    initialize: vi.fn().mockResolvedValue(undefined),
    isInitialized: vi.fn().mockReturnValue(true),
    cleanup: vi.fn().mockResolvedValue(undefined),
    // Embedding calculations
    calculateEmbedding: vi.fn().mockResolvedValue(new Array(384).fill(0.1)),
    calculateQueryEmbedding: vi.fn().mockResolvedValue(new Array(384).fill(0.1)),
    calculateEmbeddingBatch: vi.fn().mockResolvedValue([new Array(384).fill(0.1)]),
    // State
    embeddingDimensions: 384,
    modelInitialized: false,
    embeddingModel: null,
    cleaningUp: false,
    ...overrides,
  });
}

// ============================================================================
// Mock LLM Response Factory
// ============================================================================

/**
 * @typedef {Object} LLMResponse
 * @property {Object|null} json - Parsed JSON response
 * @property {string} text - Raw text response
 * @property {string} content - Content (alias for text)
 */

/**
 * Creates a mock LLM response with JSON data
 * @param {Object} json - JSON payload
 * @param {string|null} text - Optional text response
 * @returns {LLMResponse} Mock LLM response
 */
function createMockLLMResponse(json, text = null) {
  return {
    json,
    text: text || JSON.stringify(json),
    content: text || JSON.stringify(json),
  };
}

/**
 * @typedef {Object} ReviewIssue
 * @property {string} severity - Issue severity (high, medium, low)
 * @property {string} description - Issue description
 * @property {number} [line] - Line number
 * @property {string} [suggestion] - Suggested fix
 */

/**
 * Creates a successful code review response
 * @param {ReviewIssue[]} issues - List of issues
 * @param {string} summary - Review summary
 * @returns {LLMResponse} Mock review response
 */
export function createMockReviewResponse(issues = [], summary = 'Review complete') {
  return createMockLLMResponse({ summary, issues });
}

/**
 * Creates a holistic PR review response
 * @param {{summary?: string, crossFileIssues?: Array, fileSpecificIssues?: Object, recommendations?: Array}} options - Response options
 * @returns {LLMResponse} Mock holistic review response
 */
export function createMockHolisticReviewResponse(options = {}) {
  return createMockLLMResponse({
    summary: options.summary || 'PR review complete',
    crossFileIssues: options.crossFileIssues || [],
    fileSpecificIssues: options.fileSpecificIssues || {},
    recommendations: options.recommendations || [],
  });
}

// ============================================================================
// Mock GitHub Data Factories
// ============================================================================

/**
 * @typedef {Object} PRData
 * @property {number} number - PR number
 * @property {string} title - PR title
 * @property {string} state - PR state (open, closed, merged)
 * @property {string|null} merged_at - Merge timestamp
 * @property {string} created_at - Creation timestamp
 * @property {string} updated_at - Update timestamp
 * @property {{login: string}} user - PR author
 * @property {boolean} draft - Whether PR is a draft
 */

/**
 * @typedef {Object} PRComment
 * @property {string} id - Comment ID
 * @property {string} body - Comment body
 * @property {string} comment_text - Comment text (database field)
 * @property {string} author - Comment author
 * @property {string} author_login - Author login (database field)
 * @property {string} created_at - Creation timestamp
 * @property {string} file_path - File path
 * @property {number} pr_number - PR number
 * @property {string} comment_type - Comment type
 * @property {number} similarity_score - Similarity score
 * @property {string} pattern_tags - JSON-encoded pattern tags
 * @property {number} _distance - Embedding distance
 */

/**
 * Creates mock PR comment data
 * @param {Partial<PRComment>} overrides - Properties to override
 * @returns {PRComment} Mock PR comment
 */
export function createMockPRComment(overrides = {}) {
  return {
    id: `comment-${Date.now()}`,
    body: 'Test comment',
    comment_text: 'Test comment',
    author: 'reviewer',
    author_login: 'reviewer',
    created_at: new Date().toISOString(),
    file_path: '/src/file.js',
    pr_number: 1,
    comment_type: 'review',
    similarity_score: 0.8,
    pattern_tags: '[]',
    _distance: 0.2,
    ...overrides,
  };
}

/**
 * Creates mock PR search result with embedding distance
 * @param {Partial<PRComment & {matchedChunk: {code: string}}>} overrides - Properties to override
 * @returns {PRComment & {matchedChunk: {code: string}}} Mock search result
 */
export function createMockPRSearchResult(overrides = {}) {
  return {
    ...createMockPRComment(overrides),
    matchedChunk: { code: 'const x = 1;' },
  };
}

// ============================================================================
// Mock File System Helpers
// ============================================================================

/**
 * Creates mock code with specified line count
 * @param {number} lines - Number of lines to generate
 * @returns {string} Mock code string
 */
export function createMockLongCode(lines = 1000) {
  return Array.from({ length: lines }, (_, i) => `const x${i} = ${i};`).join('\n');
}

// ============================================================================
// Mock PR Files for Analysis
// ============================================================================

/**
 * @typedef {Object} PRFile
 * @property {string} path - Relative file path
 * @property {string} filePath - Absolute file path
 * @property {string} content - File content
 * @property {string} diff - Diff content
 * @property {string} diffContent - Diff content (alias)
 * @property {string} language - Programming language
 * @property {boolean} isTest - Whether file is a test file
 */

/**
 * Creates a mock PR file for holistic review
 * @param {Partial<PRFile>} overrides - Properties to override
 * @returns {PRFile} Mock PR file
 */
export function createMockPRFile(overrides = {}) {
  return {
    path: 'src/file.js',
    filePath: '/src/file.js',
    content: 'const x = 1;',
    diff: '+ const x = 1;',
    diffContent: '+ const x = 1;',
    language: 'javascript',
    isTest: false,
    ...overrides,
  };
}

/**
 * Creates unified context for PR review
 * @param {{codeExamples?: SearchResult[], guidelines?: DocumentChunk[], prComments?: PRComment[], customDocChunks?: DocumentChunk[]}} overrides - Properties to override
 * @returns {{codeExamples: SearchResult[], guidelines: DocumentChunk[], prComments: PRComment[], customDocChunks: DocumentChunk[]}} Mock unified context
 */
export function createMockUnifiedContext(overrides = {}) {
  return {
    codeExamples: overrides.codeExamples || [],
    guidelines: overrides.guidelines || [],
    prComments: overrides.prComments || [],
    customDocChunks: overrides.customDocChunks || [],
  };
}

// ============================================================================
// Test Case Data Generators
// ============================================================================

/**
 * Generates test cases for shouldSkipPR function
 * @returns {{pr: PRData|null, oldest: string|null, newest: string|null, expected: boolean, description: string}[]} Array of test case objects
 */
export function generateShouldSkipPRTestCases() {
  return [
    { pr: { merged_at: '2024-01-15' }, oldest: null, newest: null, expected: false, description: 'no date range provided' },
    { pr: null, oldest: '2024-01-01', newest: '2024-01-31', expected: false, description: 'PR is null' },
    { pr: { merged_at: '2024-01-15' }, oldest: '2024-01-01', newest: '2024-01-31', expected: true, description: 'PR within range' },
    { pr: { merged_at: '2023-12-15' }, oldest: '2024-01-01', newest: '2024-01-31', expected: false, description: 'PR before range' },
    { pr: { merged_at: '2024-02-15' }, oldest: '2024-01-01', newest: '2024-01-31', expected: false, description: 'PR after range' },
    { pr: { created_at: '2024-01-15' }, oldest: '2024-01-01', newest: '2024-01-31', expected: true, description: 'using created_at' },
    { pr: { updated_at: '2024-01-15' }, oldest: '2024-01-01', newest: '2024-01-31', expected: true, description: 'using updated_at' },
  ];
}
