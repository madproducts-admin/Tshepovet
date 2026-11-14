/**
 * RFC 9457 problem+json errors. `code` is a stable machine-readable identifier
 * that API consumers can switch on.
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  toProblem(requestId?: string) {
    return {
      type: `https://docs.tshepovet.co.za/errors/${this.code}`,
      title: this.message,
      status: this.status,
      code: this.code,
      request_id: requestId,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export const Errors = {
  validation: (details: Record<string, unknown>) =>
    new ApiError(400, 'validation_error', 'The request body failed validation', details),
  unauthorized: () => new ApiError(401, 'unauthorized', 'Missing or invalid API key'),
  forbidden: (scope: string) => new ApiError(403, 'forbidden', `API key lacks scope ${scope}`),
  insufficientFunds: (required: number, available: number) =>
    new ApiError(402, 'insufficient_funds', 'Wallet balance is insufficient for this check', {
      required_cents: required,
      available_cents: available,
    }),
  consentRequired: (purposes: string[]) =>
    new ApiError(422, 'consent_required', 'A valid consent covering the requested purposes is required', {
      missing_purposes: purposes,
    }),
  idempotencyConflict: () =>
    new ApiError(409, 'idempotency_in_progress', 'A request with this Idempotency-Key is still being processed'),
  idempotencyMismatch: () =>
    new ApiError(422, 'idempotency_key_reused', 'This Idempotency-Key was used with a different request body'),
  notFound: (what: string) => new ApiError(404, 'not_found', `${what} not found`),
  unavailable: (message = 'Verification providers are temporarily unavailable') =>
    new ApiError(503, 'providers_unavailable', message),
};
