import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  areDiagnosticsRoutedToStderr,
  configureCleanStdoutForDataOutput,
  diagnosticLog,
  installStdoutErrorHandler,
  isBrokenStdoutPipeError,
  resetCleanStdoutForDataOutput,
  shouldRouteLogsToStderrForOutput,
  writeStdout,
} from './stdout.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const reviewPipelineRoots = ['src/rag-review.js'];
const stdoutSinkAllowlist = new Set(['src/utils/stdout.js']);

function readProjectFile(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

function toProjectRelativePath(absolutePath) {
  return path.relative(projectRoot, absolutePath).replaceAll(path.sep, '/');
}

function resolveLocalImport(importer, specifier) {
  if (!specifier.startsWith('.')) {
    return null;
  }

  const importerDir = path.dirname(path.join(projectRoot, importer));
  const resolved = path.resolve(importerDir, specifier);
  const filePath = resolved.endsWith('.js') ? resolved : `${resolved}.js`;

  if (!fs.existsSync(filePath)) {
    return null;
  }

  return toProjectRelativePath(filePath);
}

function parseModule(relativePath) {
  return ts.createSourceFile(relativePath, readProjectFile(relativePath), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
}

function walkAst(node, visitor) {
  visitor(node);
  ts.forEachChild(node, (child) => walkAst(child, visitor));
}

function getReviewPipelineFiles() {
  const visited = new Set();
  const pending = [...reviewPipelineRoots];

  while (pending.length > 0) {
    const current = pending.pop();
    if (visited.has(current)) {
      continue;
    }

    visited.add(current);
    const ast = parseModule(current);

    walkAst(ast, (node) => {
      if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) {
        return;
      }

      const specifier = node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : null;
      if (typeof specifier !== 'string') {
        return;
      }

      const importedFile = resolveLocalImport(current, specifier);
      if (importedFile && !importedFile.endsWith('.test.js')) {
        pending.push(importedFile);
      }
    });
  }

  return [...visited].sort();
}

function isForbiddenStdoutCall(node) {
  if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Spinner') {
    return true;
  }

  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) {
    return false;
  }

  const propertyName = node.expression.name.text;
  const object = node.expression.expression;

  if (ts.isIdentifier(object) && object.text === 'console' && ['log', 'info'].includes(propertyName)) {
    return true;
  }

  return (
    ts.isPropertyAccessExpression(object) &&
    ts.isIdentifier(object.expression) &&
    object.expression.text === 'process' &&
    object.name.text === 'stdout' &&
    propertyName === 'write'
  );
}

function findForbiddenStdoutCall(source) {
  let forbiddenCall = null;

  walkAst(source, (node) => {
    if (!forbiddenCall && isForbiddenStdoutCall(node)) {
      forbiddenCall = node;
    }
  });

  return forbiddenCall;
}

describe('stdout utilities', () => {
  afterEach(() => {
    resetCleanStdoutForDataOutput();
    vi.restoreAllMocks();
  });

  it('routes diagnostics to stderr only for data formats written to stdout', () => {
    expect(shouldRouteLogsToStderrForOutput({ output: 'json' })).toBe(true);
    expect(shouldRouteLogsToStderrForOutput({ output: 'markdown' })).toBe(true);
    expect(shouldRouteLogsToStderrForOutput({ output: 'text' })).toBe(false);
    expect(shouldRouteLogsToStderrForOutput({ output: 'json', outputFile: 'review.json' })).toBe(false);
  });

  it('keeps stdout reserved for data payloads while routing diagnostics to stderr', () => {
    const logSpy = vi.spyOn(console, 'log');
    const errorSpy = vi.spyOn(console, 'error');
    const stdoutWriteSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    configureCleanStdoutForDataOutput({ output: 'json' });
    diagnosticLog('Starting review...');
    process.stdout.write('{"ok":true}');

    expect(logSpy).not.toHaveBeenCalledWith('Starting review...');
    expect(errorSpy).toHaveBeenCalledWith('Starting review...');
    expect(stdoutWriteSpy).toHaveBeenCalledWith('{"ok":true}');
  });

  it('keeps diagnostic routing active until explicitly reset', () => {
    configureCleanStdoutForDataOutput({ output: 'json' });

    expect(areDiagnosticsRoutedToStderr()).toBe(true);

    resetCleanStdoutForDataOutput();
    expect(areDiagnosticsRoutedToStderr()).toBe(false);
  });

  it('treats broken stdout pipes as completed writes', async () => {
    const error = Object.assign(new Error('broken pipe'), { code: 'EPIPE' });
    vi.spyOn(process.stdout, 'write').mockImplementation((_content, callback) => {
      callback(error);
      return false;
    });

    await expect(writeStdout('{"ok":true}')).resolves.toBe(false);
    expect(isBrokenStdoutPipeError(error)).toBe(true);
  });

  it('treats synchronously thrown broken stdout pipe errors as completed writes', async () => {
    const error = Object.assign(new Error('stream destroyed'), { code: 'ERR_STREAM_DESTROYED' });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => {
      throw error;
    });

    await expect(writeStdout('{"ok":true}')).resolves.toBe(false);
    expect(isBrokenStdoutPipeError(error)).toBe(true);
  });

  it('rejects non-pipe stdout write failures', async () => {
    const error = Object.assign(new Error('disk is haunted'), { code: 'EIO' });
    vi.spyOn(process.stdout, 'write').mockImplementation((_content, callback) => {
      callback(error);
      return false;
    });

    await expect(writeStdout('{"ok":true}')).rejects.toThrow('disk is haunted');
  });

  it('swallows emitted broken stdout pipe errors', () => {
    const stdout = new EventEmitter();
    installStdoutErrorHandler(stdout);

    expect(() => stdout.emit('error', Object.assign(new Error('broken pipe'), { code: 'EPIPE' }))).not.toThrow();
  });

  it('throws emitted non-pipe stdout errors', () => {
    const stdout = new EventEmitter();
    installStdoutErrorHandler(stdout);

    expect(() => stdout.emit('error', Object.assign(new Error('disk is haunted'), { code: 'EIO' }))).toThrow('disk is haunted');
  });

  it('keeps review pipeline diagnostics off raw stdout', () => {
    for (const file of getReviewPipelineFiles()) {
      if (stdoutSinkAllowlist.has(file)) {
        continue;
      }

      const forbiddenCall = findForbiddenStdoutCall(parseModule(file));
      expect(forbiddenCall, `${file} should use diagnosticLog/verboseLog/debug for diagnostics`).toBeNull();
    }
  });
});
