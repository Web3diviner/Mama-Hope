import pino, { type Logger } from 'pino';
import type { AppConfig } from '../config/env.js';

export const createLogger = (config: Pick<AppConfig, 'LOG_LEVEL' | 'NODE_ENV'>): Logger =>
  pino({
    level: config.LOG_LEVEL,
    base: { service: 'mama-hope', environment: config.NODE_ENV },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.x-internal-api-token',
        'AI_API_KEY',
        '*.whatsappJid',
        '*.phoneE164',
        '*.sourceMessageText'
      ],
      censor: '[REDACTED]'
    }
  });
