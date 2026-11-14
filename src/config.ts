import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';

export const EPHEMERAL_CHOICES = [86_400, 604_800, 7_776_000] as const;
export type EphemeralSeconds = (typeof EPHEMERAL_CHOICES)[number];

const LOG_LEVELS = new Set([
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
]);

const DEFAULT_EPHEMERAL_SECONDS: EphemeralSeconds = 604_800;
const DEFAULT_COOLDOWN_HOURS = 24;
const DEFAULT_MIN_DELAY_MINUTES = 2;
const DEFAULT_MAX_DELAY_MINUTES = 8;
const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_OPENAI_TIMEOUT_MS = 8_000;
const DEFAULT_OPENAI_MAX_RETRIES = 0;
const DEFAULT_OPENAI_TEMPERATURE = 1.05;
const DEFAULT_OPENAI_MAX_TOKENS = 60;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface AppConfig {
  allowedJids: ReadonlySet<string>;
  excludedJids: ReadonlySet<string>;
  allowAll: boolean;
  ephemeralSeconds: EphemeralSeconds;
  cooldownMs: number;
  minDelayMs: number;
  maxDelayMs: number;
  openaiApiKey?: string;
  openaiModel: string;
  openaiBaseUrl: string;
  openaiTimeoutMs: number;
  openaiMaxRetries: number;
  openaiTemperature: number;
  openaiMaxTokens: number;
  telegramBotToken?: string;
  telegramChatId?: string;
  logLevel: string;
  authDir: string;
  dataDir: string;
  statePath: string;
  auditPath: string;
}

/**
 * Normaliza um numero internacional ou um JID individual para o formato
 * "<numero>@s.whatsapp.net". Retorna null para grupos, broadcasts, status,
 * newsletters, LIDs e qualquer valor invalido.
 */
export function normalizeIndividualJid(input: string): string | null {
  if (typeof input !== 'string') {
    return null;
  }

  const trimmed = input.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }

  const atIndex = trimmed.indexOf('@');
  let localPart = trimmed;
  let server = 's.whatsapp.net';

  if (atIndex !== -1) {
    if (trimmed.indexOf('@', atIndex + 1) !== -1) {
      return null;
    }
    localPart = trimmed.slice(0, atIndex);
    server = trimmed.slice(atIndex + 1);
    if (server === 'c.us') {
      server = 's.whatsapp.net';
    }
  }

  const colonIndex = localPart.indexOf(':');
  if (colonIndex !== -1) {
    localPart = localPart.slice(0, colonIndex);
  }

  const digits = localPart.replace(/[\s()+\-.]/g, '');

  if (server === 'lid') {
    if (!/^\d{8,25}$/.test(digits)) {
      return null;
    }
    return `${digits}@lid`;
  }

  if (server !== 's.whatsapp.net') {
    return null;
  }

  if (!/^\d{8,15}$/.test(digits)) {
    return null;
  }

  return `${digits}@s.whatsapp.net`;
}

export function parseJidList(raw: string | undefined, varName = 'JIDS'): ReadonlySet<string> {
  if (!raw || !raw.trim()) {
    return new Set<string>();
  }

  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  const jids = new Set<string>();
  for (const entry of entries) {
    const jid = normalizeIndividualJid(entry);
    if (!jid) {
      throw new ConfigError(
        `${varName} contem uma entrada invalida: "${entry}". Use apenas contatos individuais no formato internacional, sem "+".`,
      );
    }
    jids.add(jid);
  }

  return jids;
}

export function parseAllowedJids(
  raw: string | undefined,
  hasExcluded = false,
): ReadonlySet<string> {
  const trimmed = raw?.trim();

  if (trimmed === '*') {
    return new Set(['*']);
  }

  if (!trimmed) {
    if (hasExcluded) {
      return new Set(['*']);
    }
    throw new ConfigError(
      'ALLOWED_JIDS esta vazio. Informe ao menos um numero internacional, "*" para todos, ou configure EXCLUDED_JIDS.',
    );
  }

  const entries = trimmed
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (entries.length === 0) {
    if (hasExcluded) {
      return new Set(['*']);
    }
    throw new ConfigError(
      'ALLOWED_JIDS esta vazio. Informe ao menos um numero internacional, "*" para todos, ou configure EXCLUDED_JIDS.',
    );
  }

  const jids = new Set<string>();
  for (const entry of entries) {
    if (entry === '*') {
      jids.add('*');
      continue;
    }
    const jid = normalizeIndividualJid(entry);
    if (!jid) {
      throw new ConfigError(
        `ALLOWED_JIDS contem uma entrada invalida: "${entry}". Use apenas contatos individuais no formato internacional, sem "+".`,
      );
    }
    jids.add(jid);
  }

  return jids;
}

export function parseExcludedJids(raw: string | undefined): ReadonlySet<string> {
  return parseJidList(raw, 'EXCLUDED_JIDS');
}

export function isJidMonitored(
  jid: string,
  config: Pick<AppConfig, 'allowedJids' | 'excludedJids' | 'allowAll'>,
  resolveJid?: (jid: string) => string | undefined,
): boolean {
  const alternateJid = resolveJid ? resolveJid(jid) : undefined;

  if (
    config.excludedJids.has(jid) ||
    (alternateJid !== undefined && config.excludedJids.has(alternateJid))
  ) {
    return false;
  }
  if (config.allowAll || config.allowedJids.has('*')) {
    return true;
  }
  return (
    config.allowedJids.has(jid) ||
    (alternateJid !== undefined && config.allowedJids.has(alternateJid))
  );
}

function readString(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function readUrl(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const raw = readString(env, key);
  if (raw === undefined) {
    return fallback;
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ConfigError(`${key} deve ser uma URL valida. Valor recebido: "${raw}".`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ConfigError(`${key} deve usar http ou https. Valor recebido: "${raw}".`);
  }

  return parsed.toString().replace(/\/+$/, '');
}

function readNumber(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  options: { min: number; max: number },
): number {
  const raw = readString(env, key);
  if (raw === undefined) {
    return fallback;
  }

  if (!/^-?\d+(?:\.\d+)?$/.test(raw)) {
    throw new ConfigError(`${key} deve ser um numero. Valor recebido: "${raw}".`);
  }

  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new ConfigError(`${key} deve ser um numero finito.`);
  }
  if (value < options.min || value > options.max) {
    throw new ConfigError(
      `${key} deve estar entre ${options.min} e ${options.max}. Valor recebido: ${value}.`,
    );
  }

  return value;
}

function readInteger(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  options: { min: number; max: number },
): number {
  const raw = readString(env, key);
  if (raw === undefined) {
    return fallback;
  }

  if (!/^-?\d+$/.test(raw)) {
    throw new ConfigError(`${key} deve ser um numero inteiro. Valor recebido: "${raw}".`);
  }

  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new ConfigError(`${key} deve ser um numero inteiro seguro.`);
  }
  if (value < options.min || value > options.max) {
    throw new ConfigError(
      `${key} deve estar entre ${options.min} e ${options.max}. Valor recebido: ${value}.`,
    );
  }

  return value;
}

export function buildConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const excludedJids = parseExcludedJids(env.EXCLUDED_JIDS);
  const allowedJids = parseAllowedJids(env.ALLOWED_JIDS, excludedJids.size > 0);
  const allowAll = allowedJids.has('*');

  const ephemeralRaw = readInteger(
    env,
    'EPHEMERAL_SECONDS',
    DEFAULT_EPHEMERAL_SECONDS,
    { min: 0, max: 10_000_000 },
  );
  if (!(EPHEMERAL_CHOICES as readonly number[]).includes(ephemeralRaw)) {
    throw new ConfigError(
      `EPHEMERAL_SECONDS deve ser 86400, 604800 ou 7776000. Valor recebido: ${ephemeralRaw}.`,
    );
  }
  const ephemeralSeconds = ephemeralRaw as EphemeralSeconds;

  const cooldownHours = readInteger(env, 'COOLDOWN_HOURS', DEFAULT_COOLDOWN_HOURS, {
    min: 0,
    max: 24 * 365,
  });
  const minDelayMinutes = readInteger(env, 'MIN_DELAY_MINUTES', DEFAULT_MIN_DELAY_MINUTES, {
    min: 0,
    max: 525_600,
  });
  const maxDelayMinutes = readInteger(env, 'MAX_DELAY_MINUTES', DEFAULT_MAX_DELAY_MINUTES, {
    min: 0,
    max: 525_600,
  });

  if (minDelayMinutes > maxDelayMinutes) {
    throw new ConfigError(
      `MIN_DELAY_MINUTES (${minDelayMinutes}) nao pode ser maior que MAX_DELAY_MINUTES (${maxDelayMinutes}).`,
    );
  }

  const logLevel = readString(env, 'LOG_LEVEL') ?? 'info';
  if (!LOG_LEVELS.has(logLevel)) {
    throw new ConfigError(
      `LOG_LEVEL invalido: "${logLevel}". Use fatal, error, warn, info, debug, trace ou silent.`,
    );
  }

  const authDir = path.resolve(process.cwd(), readString(env, 'AUTH_DIR') ?? 'auth');
  const dataDir = path.resolve(process.cwd(), readString(env, 'DATA_DIR') ?? 'data');

  const openaiApiKey = readString(env, 'OPENAI_API_KEY');
  const openaiBaseUrl = readUrl(env, 'OPENAI_BASE_URL', DEFAULT_OPENAI_BASE_URL);
  const openaiTimeoutMs = readInteger(env, 'OPENAI_TIMEOUT_MS', DEFAULT_OPENAI_TIMEOUT_MS, {
    min: 100,
    max: 300_000,
  });
  const openaiMaxRetries = readInteger(env, 'OPENAI_MAX_RETRIES', DEFAULT_OPENAI_MAX_RETRIES, {
    min: 0,
    max: 10,
  });
  const openaiTemperature = readNumber(
    env,
    'OPENAI_TEMPERATURE',
    DEFAULT_OPENAI_TEMPERATURE,
    { min: 0, max: 2 },
  );
  const openaiMaxTokens = readInteger(env, 'OPENAI_MAX_TOKENS', DEFAULT_OPENAI_MAX_TOKENS, {
    min: 1,
    max: 4_096,
  });

  const telegramBotToken = readString(env, 'TELEGRAM_BOT_TOKEN') ?? readString(env, 'TELEGRAM_TOKEN');
  const telegramChatId = readString(env, 'TELEGRAM_CHAT_ID');

  return {
    allowedJids,
    excludedJids,
    allowAll,
    ephemeralSeconds,
    cooldownMs: cooldownHours * 60 * 60 * 1000,
    minDelayMs: minDelayMinutes * 60 * 1000,
    maxDelayMs: maxDelayMinutes * 60 * 1000,
    ...(openaiApiKey ? { openaiApiKey } : {}),
    openaiModel: readString(env, 'OPENAI_MODEL') ?? DEFAULT_OPENAI_MODEL,
    openaiBaseUrl,
    openaiTimeoutMs,
    openaiMaxRetries,
    openaiTemperature,
    openaiMaxTokens,
    ...(telegramBotToken ? { telegramBotToken } : {}),
    ...(telegramChatId ? { telegramChatId } : {}),
    logLevel,
    authDir,
    dataDir,
    statePath: path.join(dataDir, 'state.json'),
    auditPath: path.join(dataDir, 'audit.jsonl'),
  };
}

export function ensureRuntimeDirs(config: Pick<AppConfig, 'authDir' | 'dataDir'>): void {
  mkdirSync(config.authDir, { recursive: true, mode: 0o700 });
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
}

export function loadConfig(): AppConfig {
  loadEnv({ quiet: true });
  return buildConfig(process.env);
}
