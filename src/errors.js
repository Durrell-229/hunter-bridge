/** Erreur normalisée du pont, destinée à Claude Code. */
export class BridgeError extends Error {
  constructor(message, options = {}) {
    super(String(message || 'Erreur inconnue'), { cause: options.cause });
    this.name = 'BridgeError';
    this.status = Number.isInteger(options.status) ? options.status : 500;
    this.type = options.type || errorTypeForStatus(this.status);
    this.upstreamStatus = options.upstreamStatus;
    this.retryAfter = options.retryAfter;
    this.clientAborted = Boolean(options.clientAborted);
  }
}

/** Types d'erreur officiels de l'API Anthropic. */
export function errorTypeForStatus(status) {
  if (status === 401) return 'authentication_error';
  if (status === 403) return 'permission_error';
  if (status === 404) return 'not_found_error';
  if (status === 413) return 'request_too_large';
  if (status === 429) return 'rate_limit_error';
  if (status === 529) return 'overloaded_error';
  if (status >= 500) return 'api_error';
  return 'invalid_request_error';
}

/** Corps d'erreur Anthropic. */
export function anthropicErrorBody(err, requestId = null) {
  const status = err.status || 500;
  const body = {
    type: 'error',
    error: {
      type: err.type || errorTypeForStatus(status),
      message: err.message || 'Erreur interne du proxy',
    },
  };
  if (requestId) body.request_id = requestId;
  return body;
}

/** Convertit n'importe quelle exception en BridgeError. */
export function asBridgeError(err) {
  if (err instanceof BridgeError) return err;
  return new BridgeError(err?.message || 'Erreur interne du proxy', {
    status: 500,
    type: 'api_error',
    cause: err,
  });
}
