import { z } from 'zod';

const optionalValue = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  ORGANIZATION_NAME: z.string().min(1).default('DeExclusives Music Organization'),
  BOT_NAME: z.string().min(1).default('Mama Hope'),
  ORGANIZATION_TIMEZONE: z.string().min(1).default('Africa/Lagos'),
  STORE_DRIVER: z.enum(['memory', 'postgres']).default('memory'),
  DATABASE_URL: optionalValue(z.string().url()),
  REDIS_URL: optionalValue(z.string().url()),
  SUPER_ADMIN_WHATSAPP_JID: z.string().min(5),
  BOT_WHATSAPP_JID: z.string().min(5),
  INTERNAL_API_TOKEN: z.string().min(16),
  WHATSAPP_GATEWAY: z.enum(['memory', 'baileys']).default('memory'),
  WHATSAPP_SEND_ENABLED: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  AUTO_SEND_DAILY_SUMMARY: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  WHATSAPP_SESSION_DIR: z.string().default('./data/whatsapp-session'),
  WHATSAPP_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  WHATSAPP_PAIRING_PHONE: optionalValue(z.string().regex(/^\d+$/)),
  WHATSAPP_HOST_IP: optionalValue(z.string().ip({ version: 'v4' })),
  OFFICIALS_GROUP_JID: optionalValue(z.string().regex(/^\d+@g\.us$/)),
  OFFICIALS_GROUP_NAME: optionalValue(z.string().min(1)),
  COMMUNITY_GROUP_JID: optionalValue(z.string().regex(/^\d+@g\.us$/)),
  COMMUNITY_GROUP_NAME: optionalValue(z.string().min(1)),
  BOOTSTRAP_OFFICIALS_JSON: optionalValue(z.string().min(2)),
  MEDIA_DRIVER: z.enum(['local', 's3']).default('local'),
  MEDIA_LOCAL_DIR: z.string().default('./data/media'),
  S3_ENDPOINT: optionalValue(z.string().url()),
  S3_REGION: z.string().min(1).default('auto'),
  S3_BUCKET: optionalValue(z.string().min(1)),
  S3_ACCESS_KEY_ID: optionalValue(z.string().min(1)),
  S3_SECRET_ACCESS_KEY: optionalValue(z.string().min(1)),
  AI_PROVIDER: z.enum(['rules', 'groq']).default('rules'),
  AI_MODEL: optionalValue(z.string().min(1)),
  AI_MODELS: optionalValue(z.string().min(1)),
  AI_API_KEY: optionalValue(z.string().min(1)),
  AI_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  GOOGLE_CALENDAR_ID: optionalValue(z.string().min(1)),
  GOOGLE_CALENDAR_ACCESS_TOKEN: optionalValue(z.string().min(1)),
  OPPORTUNITY_RSS_URLS: optionalValue(z.string().min(1))
});

export type AppConfig = z.infer<typeof schema>;

export const loadConfig = (values: NodeJS.ProcessEnv = process.env): AppConfig => {
  const result = schema.safeParse(values);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  if (result.data.STORE_DRIVER === 'postgres' && !result.data.DATABASE_URL) {
    throw new Error('DATABASE_URL is required when STORE_DRIVER=postgres.');
  }
  if (result.data.NODE_ENV === 'production' && result.data.STORE_DRIVER !== 'postgres') {
    throw new Error('Production requires STORE_DRIVER=postgres so tasks and schedules survive restarts.');
  }
  if (result.data.NODE_ENV === 'production' && !result.data.REDIS_URL) {
    throw new Error('Production requires REDIS_URL for durable scheduled-job delivery.');
  }
  if (result.data.NODE_ENV === 'production' && result.data.WHATSAPP_GATEWAY !== 'baileys') {
    throw new Error('Production requires WHATSAPP_GATEWAY=baileys; the memory gateway is only for development and tests.');
  }
  if (result.data.NODE_ENV === 'production' && result.data.MEDIA_DRIVER !== 's3') {
    throw new Error('Production requires MEDIA_DRIVER=s3 so attachments survive container and volume failures.');
  }
  if (result.data.NODE_ENV === 'production' && result.data.INTERNAL_API_TOKEN.length < 32) {
    throw new Error('Production requires an INTERNAL_API_TOKEN of at least 32 characters.');
  }
  if (result.data.WHATSAPP_GATEWAY === 'baileys' && !result.data.WHATSAPP_SESSION_DIR) {
    throw new Error('WHATSAPP_SESSION_DIR is required when WHATSAPP_GATEWAY=baileys.');
  }
  if (Boolean(result.data.OFFICIALS_GROUP_JID) !== Boolean(result.data.OFFICIALS_GROUP_NAME)) {
    throw new Error('OFFICIALS_GROUP_JID and OFFICIALS_GROUP_NAME must be configured together.');
  }
  if (Boolean(result.data.COMMUNITY_GROUP_JID) !== Boolean(result.data.COMMUNITY_GROUP_NAME)) {
    throw new Error('COMMUNITY_GROUP_JID and COMMUNITY_GROUP_NAME must be configured together.');
  }
  if (result.data.MEDIA_DRIVER === 's3') {
    const required = ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const;
    const missing = required.filter((key) => !result.data[key]);
    if (missing.length) throw new Error(`Missing S3 configuration: ${missing.join(', ')}.`);
  }
  if (result.data.AI_PROVIDER === 'groq' && !result.data.AI_API_KEY) {
    throw new Error('AI_API_KEY is required when AI_PROVIDER=groq.');
  }
  return result.data;
};
