import pino from 'pino';

/**
 * Structured logger with POPIA-driven redaction. Identifiers must never reach
 * log storage (often a third-party SaaS outside South Africa - POPIA s72).
 * Redaction is defence in depth: code should log references, not values.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers["x-hub-signature-256"]',
      '*.tcs_pin',
      '*.pin',
      '*.id_number',
      '*.idNumber',
      '*.tax_reference_number',
      '*.licence_number',
      '*.account_number',
      '*.msisdn',
      '*.phone',
      'body',
    ],
    censor: '[REDACTED]',
  },
  base: { service: 'tshepovet-api' },
});

export type Logger = typeof logger;
