export class CliError extends Error {
  constructor(code, message, { next, retryable = false, outcome = 'not-started', cause } = {}) {
    super(message, { cause });
    this.code = code;
    this.next = next;
    this.retryable = retryable;
    this.outcome = outcome;
    if (cause instanceof CliError && cause.upstreamCode !== undefined) this.upstreamCode = cause.upstreamCode;
  }
}
export const usageError = message => new CliError('INVALID_ARGUMENT', message, { next: 'Inspect mmx schema <command> and correct the arguments.' });
export function errorResult(error) {
  const nativeUsage = String(error.code || '').startsWith('ERR_PARSE_ARGS');
  return {
    status: 'error',
    error: error.message || 'Command failed.',
    code: nativeUsage ? 'INVALID_ARGUMENT' : error instanceof CliError ? error.code : 'COMMAND_FAILED',
    retryable: error instanceof CliError ? error.retryable : false,
    outcome: nativeUsage ? 'not-started' : error instanceof CliError ? error.outcome : 'unknown',
    ...(error.upstreamCode !== undefined ? { upstreamCode: error.upstreamCode } : {}),
    next: error.next || (nativeUsage ? 'Inspect mmx schema <command> and correct the arguments.'
      : 'Inspect the error. Before retrying a mutation, read the target to verify whether it completed.'),
  };
}
// Keep upstream diagnostics under their own namespace; an arbitrary upstream code is
// not a promise about safe retries. Do not include tokens, headers or request bodies.
export function upstreamError(result, fallback) {
  let value = result.structuredContent;
  if (!value) {
    try { value = JSON.parse(result.content?.filter(item => item.type === 'text').map(item => item.text).join('\n') || ''); } catch {}
  }
  const error = new CliError('UPSTREAM_ERROR', typeof value?.error === 'string' ? value.error
    : typeof value?.error?.message === 'string' ? value.error.message
    : result.content?.filter(item => item.type === 'text').map(item => item.text).join('\n') || fallback,
  { outcome: 'unknown' });
  const code = value?.code ?? value?.error?.code;
  if (typeof code === 'string' || typeof code === 'number') error.upstreamCode = code;
  return error;
}
