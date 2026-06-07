const STDOUT_DATA_OUTPUT_FORMATS = new Set(['json', 'markdown']);
const stdoutErrorHandlerInstalled = new WeakSet();

let routeDiagnosticsToStderr = false;

export function shouldRouteLogsToStderrForOutput(options = {}) {
  return Boolean(!options.outputFile && STDOUT_DATA_OUTPUT_FORMATS.has(options.output));
}

export function configureCleanStdoutForDataOutput(options = {}) {
  routeDiagnosticsToStderr = shouldRouteLogsToStderrForOutput(options);
  return routeDiagnosticsToStderr;
}

export function resetCleanStdoutForDataOutput() {
  routeDiagnosticsToStderr = false;
}

export function areDiagnosticsRoutedToStderr() {
  return routeDiagnosticsToStderr;
}

export function diagnosticLog(...args) {
  if (routeDiagnosticsToStderr) {
    console.error(...args);
  }
  else {
    console.log(...args);
  }
}

export function isBrokenStdoutPipeError(error) {
  return error?.code === 'EPIPE' || error?.code === 'ERR_STREAM_DESTROYED';
}

export function installStdoutErrorHandler(stdout = process.stdout) {
  if (stdoutErrorHandlerInstalled.has(stdout)) {
    return false;
  }

  stdout.on('error', (error) => {
    if (isBrokenStdoutPipeError(error)) {
      return;
    }

    throw error;
  });
  stdoutErrorHandlerInstalled.add(stdout);
  return true;
}

export function writeStdout(content) {
  return new Promise((resolve, reject) => {
    const handleWriteError = (error) => {
      if (!error) {
        resolve(true);
        return;
      }

      if (isBrokenStdoutPipeError(error)) {
        resolve(false);
        return;
      }

      reject(error);
    };

    try {
      process.stdout.write(content, handleWriteError);
    }
    catch (error) {
      handleWriteError(error);
    }
  });
}

installStdoutErrorHandler();
