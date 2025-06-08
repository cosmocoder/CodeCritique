/**
 * Default Configuration for AI Code Review Tool
 *
 * This file contains the default configuration which can be customized by users
 * to support different programming languages and frameworks.
 */

export default {
  // Languages supported by the tool
  languages: {
    javascript: {
      extensions: ['.js', '.mjs', '.cjs'],
      type: 'programming',
      blockDelimiters: [{ begin: /{/, end: /}/, type: 'brace' }],
      blockStarterPatterns: [/(\w+)\s*\([^)]*\)\s*[{:]/, /(\w+)\s*[{:]/],
      patternCategories: ['codeFormatting', 'comments', 'imports', 'performance'],
      promptTemplate: 'javascript',
    },
    jsx: {
      extensions: ['.jsx'],
      type: 'programming',
      blockDelimiters: [{ begin: /{/, end: /}/, type: 'brace' }],
      blockStarterPatterns: [/(\w+)\s*\([^)]*\)\s*[{:]/, /(\w+)\s*[{:]/, /(\w+)\s*=\s*\([^)]*\)\s*=>/],
      patternCategories: ['codeFormatting', 'comments', 'imports', 'componentNaming', 'stateManagement', 'hooks', 'performance'],
      promptTemplate: 'react',
    },
    typescript: {
      extensions: ['.ts'],
      type: 'programming',
      blockDelimiters: [{ begin: /{/, end: /}/, type: 'brace' }],
      blockStarterPatterns: [/(\w+)\s*\([^)]*\)\s*[{:]/, /(\w+)\s*[{:]/, /interface\s+(\w+)/, /type\s+(\w+)/],
      patternCategories: ['codeFormatting', 'comments', 'imports', 'typeDefinitions'],
      promptTemplate: 'typescript',
    },
    tsx: {
      extensions: ['.tsx'],
      type: 'programming',
      blockDelimiters: [{ begin: /{/, end: /}/, type: 'brace' }],
      blockStarterPatterns: [/(\w+)\s*\([^)]*\)\s*[{:]/, /(\w+)\s*[{:]/, /(\w+)\s*=\s*\([^)]*\)\s*=>/, /interface\s+(\w+)/, /type\s+(\w+)/],
      patternCategories: [
        'codeFormatting',
        'comments',
        'imports',
        'componentNaming',
        'stateManagement',
        'hooks',
        'propTypes',
        'typeDefinitions',
      ],
      promptTemplate: 'react-typescript',
    },
    python: {
      extensions: ['.py'],
      type: 'programming',
      blockDelimiters: [{ begin: /:/, end: null, type: 'indentation' }],
      blockStarterPatterns: [/def\s+(\w+)\s*\(/, /class\s+(\w+)/, /if\s+/, /for\s+/, /while\s+/],
      patternCategories: ['codeFormatting', 'comments', 'imports', 'classDesign', 'functionDesign'],
      promptTemplate: 'python',
    },
    css: {
      extensions: ['.css'],
      type: 'markup',
      blockDelimiters: [{ begin: /{/, end: /}/, type: 'brace' }],
      blockStarterPatterns: [/([.#]\w+|\w+|\*)/],
      patternCategories: ['styling', 'accessibility'],
      promptTemplate: 'css',
    },
    scss: {
      extensions: ['.scss'],
      type: 'markup',
      blockDelimiters: [{ begin: /{/, end: /}/, type: 'brace' }],
      blockStarterPatterns: [/([.#]\w+|\w+|\*)/, /@mixin\s+(\w+)/, /@include\s+(\w+)/],
      patternCategories: ['styling', 'accessibility'],
      promptTemplate: 'css',
    },
    java: {
      extensions: ['.java'],
      type: 'programming',
      blockDelimiters: [{ begin: /{/, end: /}/, type: 'brace' }],
      blockStarterPatterns: [/(\w+)\s*\([^)]*\)\s*[{:]/, /class\s+(\w+)/, /interface\s+(\w+)/],
      patternCategories: ['codeFormatting', 'comments', 'imports', 'classDesign', 'errorHandling'],
      promptTemplate: 'java',
    },
    go: {
      extensions: ['.go'],
      type: 'programming',
      blockDelimiters: [{ begin: /{/, end: /}/, type: 'brace' }],
      blockStarterPatterns: [/func\s+(\w+)\s*\(/, /type\s+(\w+)\s+struct/, /type\s+(\w+)\s+interface/],
      patternCategories: ['codeFormatting', 'comments', 'imports', 'errorHandling'],
      promptTemplate: 'go',
    },
    // GraphQL support
    graphql: {
      extensions: ['.graphql', '.gql'],
      type: 'query',
      blockDelimiters: [{ begin: /{/, end: /}/, type: 'brace' }],
      blockStarterPatterns: [
        /type\s+(\w+)/,
        /input\s+(\w+)/,
        /enum\s+(\w+)/,
        /interface\s+(\w+)/,
        /query\s+(\w+)/,
        /mutation\s+(\w+)/,
        /subscription\s+(\w+)/,
      ],
      patternCategories: ['codeFormatting', 'queryStructure', 'typeDefinitions'],
      promptTemplate: 'graphql',
    },
    // Add more languages as needed
  },

  // Prompt templates for different file types
  promptTemplates: {
    // Default prompt for any code file
    default: `
You are an expert code reviewer with deep knowledge of software engineering principles.
Review the following code and provide constructive feedback:

CODE:
{code}

DIFF:
{diff}

{project_patterns}

Please analyze the code for:
1. Potential bugs or errors
2. Performance issues
3. Maintainability concerns
4. Adherence to best practices
5. Security vulnerabilities
6. Alignment with team-specific patterns and conventions

Focus on providing actionable feedback with specific suggestions for improvement.
Make sure your suggestions are consistent with the team's established patterns.
`,

    // JavaScript-specific prompt
    javascript: `
You are an expert JavaScript developer with deep knowledge of JavaScript best practices and patterns.
Review the following JavaScript code and provide constructive feedback:

CODE:
{code}

DIFF:
{diff}

{project_patterns}

Please analyze the code for:
1. JavaScript-specific issues and anti-patterns
2. Proper error handling
3. Asynchronous code management
4. Performance concerns
5. Security issues
6. Adherence to JavaScript best practices
7. Consistency with team patterns

Focus on providing actionable feedback with specific suggestions for improvement.
`,

    // React component prompt
    react: `
You are an expert React developer with deep knowledge of React best practices and patterns.
Review the following React component and provide constructive feedback:

COMPONENT:
{code}

DIFF:
{diff}

{project_patterns}

{react_specific_patterns}

Please analyze the component for:
1. Component structure and organization
2. Props usage and validation
3. State management
4. Performance optimizations (memoization, etc.)
5. Side effects handling
6. Adherence to React best practices
7. Accessibility concerns
8. Potential bugs or edge cases
9. Consistency with team's component patterns

Focus on providing actionable feedback with specific suggestions for improvement.
Where possible, reference established patterns used elsewhere in the codebase.
`,

    // TypeScript-specific prompt
    typescript: `
You are an expert TypeScript developer with deep knowledge of TypeScript best practices and type system.
Review the following TypeScript code and provide constructive feedback:

CODE:
{code}

DIFF:
{diff}

{project_patterns}

{typescript_specific_patterns}

Please analyze the code for:
1. Type correctness and accuracy
2. Type safety and strictness
3. Interface and type design
4. Proper use of TypeScript features (generics, unions, etc.)
5. Potential type issues or edge cases
6. Adherence to TypeScript best practices
7. Consistency with project's type conventions

Focus on providing actionable feedback with specific suggestions for improvement.
Ensure your recommendations align with the established type patterns in the project.
`,

    // React with TypeScript prompt
    'react-typescript': `
You are an expert React and TypeScript developer with deep knowledge of both technologies' best practices.
Review the following React TypeScript component and provide constructive feedback:

COMPONENT:
{code}

DIFF:
{diff}

{project_patterns}

{react_specific_patterns}
{typescript_specific_patterns}

Please analyze the component for:
1. Component structure and type safety
2. Props interface design and usage
3. State management with proper typing
4. Performance optimizations
5. Side effects handling
6. TypeScript-specific considerations
7. Accessibility concerns
8. Potential bugs or edge cases
9. Consistency with team's established patterns

Focus on providing actionable feedback with specific suggestions for improvement.
`,

    // Python-specific prompt
    python: `
You are an expert Python developer with deep knowledge of Python best practices and patterns.
Review the following Python code and provide constructive feedback:

CODE:
{code}

DIFF:
{diff}

{project_patterns}

Please analyze the code for:
1. Python-specific issues and anti-patterns
2. Proper error handling
3. Code organization and structure
4. Performance concerns
5. Security issues
6. Adherence to PEP 8 and Python best practices
7. Consistency with team patterns

Focus on providing actionable feedback with specific suggestions for improvement.
`,

    // CSS-specific prompt
    css: `
You are an expert in CSS and web styling with deep knowledge of CSS best practices.
Review the following CSS code and provide constructive feedback:

CODE:
{code}

DIFF:
{diff}

{project_patterns}

Please analyze the code for:
1. CSS structure and organization
2. Performance issues
3. Browser compatibility concerns
4. Accessibility issues
5. Maintainability concerns
6. Adherence to CSS best practices
7. Consistency with styling patterns

Focus on providing actionable feedback with specific suggestions for improvement.
`,

    // Java-specific prompt
    java: `
You are an expert Java developer with deep knowledge of Java best practices and patterns.
Review the following Java code and provide constructive feedback:

CODE:
{code}

DIFF:
{diff}

{project_patterns}

Please analyze the code for:
1. Java-specific issues and anti-patterns
2. Proper exception handling
3. Code organization and structure
4. Performance concerns
5. Security issues
6. Adherence to Java conventions and best practices
7. Consistency with team patterns

Focus on providing actionable feedback with specific suggestions for improvement.
`,

    // Go-specific prompt
    go: `
You are an expert Go developer with deep knowledge of Go best practices and idioms.
Review the following Go code and provide constructive feedback:

CODE:
{code}

DIFF:
{diff}

{project_patterns}

Please analyze the code for:
1. Go-specific issues and anti-patterns
2. Proper error handling
3. Code organization and structure
4. Performance concerns
5. Security issues
6. Adherence to Go idioms and best practices
7. Consistency with team patterns

Focus on providing actionable feedback with specific suggestions for improvement.
`,
    // GraphQL-specific prompt
    graphql: `
You are an expert GraphQL developer with deep knowledge of GraphQL schema design and best practices.
Review the following GraphQL schema and provide constructive feedback:

SCHEMA:
{code}

DIFF:
{diff}

{project_patterns}

Please analyze the schema for:
1. GraphQL schema design best practices
2. Type definitions and relationships
3. Query and mutation structure
4. Performance considerations
5. Potential issues or edge cases
6. Consistency with project's schema conventions

Focus on providing actionable feedback with specific suggestions for improvement.
`,
    // Add more templates as needed
  },

  // Rules for PR pattern detection
  patternDetection: {
    detectionRules: {
      // Common categories across languages
      codeFormatting: /format(ting)?|indent(ation)?|spacing/i,
      comments: /comment/i,
      imports: /imports?/i,
      performance: /performance/i,
      security: /security|auth|authent|authoriz/i,
      errorHandling: /error.*?handl(e|ing)/i,

      // JavaScript/TypeScript specific
      componentNaming: /component.*nam(e|ing)/i,
      stateManagement: /state.*?manag(e|ing|ement)/i,
      hooks: /hooks?/i,
      propTypes: /props?.*?(type|validation|interface)/i,
      typeDefinitions: /type|interface|enum/i,

      // Python specific
      classDesign: /class.*?design|inheritance/i,
      functionDesign: /function|method|def/i,

      // CSS specific
      styling: /styling|css|selector/i,
      accessibility: /a11y|accessibility/i,

      // GraphQL specific
      queryStructure: /query|mutation|subscription|structure/i,
      schemaDesign: /schema|type|input|enum|interface/i,
    },
    ruleRegexes: {
      componentNaming: /should.*?([A-Z]\w+Case|match|follow)/i,
      fileStructure: /should.*?(be in|follow|match)/i,
      hooks: /should.*?(start with|use|follow)/i,
      performance: /should.*?(memorize|optimize|avoid)/i,
      comments: /should.*?(include|document|explain)/i,
    },
  },

  // File detection patterns
  fileTypeDetection: {
    // React component detection
    react: {
      extensions: ['.jsx', '.tsx'],
      contentPatterns: [
        /import.*?React/,
        /React\.(Component|PureComponent|memo)/,
        /function.*?\(.*?\).*?{.*?return.*?</,
        /const.*?=.*?\(.*?\).*?=>.*?</,
      ],
    },
    // TypeScript type definition detection
    typeDefinition: {
      extensions: ['.d.ts', '.ts'],
      contentPatterns: [/interface\s+\w+/, /type\s+\w+\s*=/, /enum\s+\w+/, /namespace\s+\w+/],
    },
    // GraphQL schema detection
    graphql: {
      extensions: ['.graphql', '.gql'],
      contentPatterns: [
        /type\s+\w+/,
        /input\s+\w+/,
        /enum\s+\w+/,
        /interface\s+\w+/,
        /query\s+\w+/,
        /mutation\s+\w+/,
        /subscription\s+\w+/,
      ],
    },
    // Add more file type detections as needed
  },
};
