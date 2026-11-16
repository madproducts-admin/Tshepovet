import { z } from 'zod';

const b64Key = z
  .string()
  .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be base64 encoding of exactly 32 bytes');

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  // Behind a reverse proxy, bind 127.0.0.1 so the port is never reachable from outside.
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().url(),
  WORKER_DATABASE_URL: z.string().url().optional(),
  REDIS_URL: z.string().default('redis://localhost:6379/0'),

  KEK_KEYS: z.string().min(1),
  BLIND_INDEX_ROOT_KEY: b64Key,
  API_KEY_PEPPER: b64Key,

  ENABLED_PROVIDERS: z.string().default('mock'),
  SYNC_DEADLINE_MS: z.coerce.number().int().positive().default(8000),
  COMPANY_CHECK_COST_CEILING_CENTS: z.coerce.number().int().nonnegative().default(240),
  DRIVER_CHECK_COST_CEILING_CENTS: z.coerce.number().int().nonnegative().default(200),

  XDS_BASE_URL: z.string().optional(),
  XDS_API_KEY: z.string().optional(),
  CPB_BASE_URL: z.string().optional(),
  CPB_API_KEY: z.string().optional(),
  SEARCHWORKS_BASE_URL: z.string().optional(),
  SEARCHWORKS_API_KEY: z.string().optional(),
  VERIFYID_BASE_URL: z.string().optional(),
  VERIFYID_API_KEY: z.string().optional(),

  WHATSAPP_VERIFY_TOKEN: z.string().optional(),
  WHATSAPP_APP_SECRET: z.string().optional(),
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_GRAPH_VERSION: z.string().default('v23.0'),

  OCR_MODEL: z.string().default('claude-opus-5-5'),

  // --- Portal accounts (docs/PLAN.md M2) ---------------------------------------------
  /** Base URL for links in emails (verify, reset, invite). */
  APP_URL: z.string().url().default('https://tshepovet.madproducts.ai'),
  /** __Host- prefixed, Secure cookies. Default: on in production, off otherwise (plain-http tests). */
  COOKIE_SECURE: z.enum(['true', 'false']).optional(),
  SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).max(24 * 60).default(12 * 60),
  SESSION_ABSOLUTE_HOURS: z.coerce.number().int().min(1).max(30 * 24).default(7 * 24),
  AUTH_MAX_FAILURES: z.coerce.number().int().min(3).max(20).default(5),
  AUTH_LOCK_MINUTES: z.coerce.number().int().min(1).max(24 * 60).default(15),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  return parsed.data;
}
