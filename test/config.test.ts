import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ConfigError,
  buildConfig,
  isJidMonitored,
  normalizeIndividualJid,
  parseAllowedJids,
  parseExcludedJids,
} from '../src/config.js';

function env(values: Record<string, string>): NodeJS.ProcessEnv {
  return { ...values } as NodeJS.ProcessEnv;
}

void test('normalizeIndividualJid aceita numeros e JIDs individuais', () => {
  assert.equal(
    normalizeIndividualJid('5521999999999'),
    '5521999999999@s.whatsapp.net',
  );
  assert.equal(
    normalizeIndividualJid('+55 (21) 99999-9999'),
    '5521999999999@s.whatsapp.net',
  );
  assert.equal(
    normalizeIndividualJid('5521999999999@c.us'),
    '5521999999999@s.whatsapp.net',
  );
  assert.equal(
    normalizeIndividualJid('75724719411447@lid'),
    '75724719411447@lid',
  );
});

void test('normalizeIndividualJid rejeita grupos, broadcast, status e newsletter', () => {
  assert.equal(normalizeIndividualJid('123456789-987654@g.us'), null);
  assert.equal(normalizeIndividualJid('status@broadcast'), null);
  assert.equal(normalizeIndividualJid('123456789@broadcast'), null);
  assert.equal(normalizeIndividualJid('123456789@newsletter'), null);
  assert.equal(normalizeIndividualJid('abc'), null);
});

void test('parseAllowedJids normaliza, remove duplicatas e exige allowlist', () => {
  const jids = parseAllowedJids('5521999999999, 5521999999999@c.us,5521888888888');
  assert.deepEqual([...jids].sort(), [
    '5521888888888@s.whatsapp.net',
    '5521999999999@s.whatsapp.net',
  ]);

  assert.throws(() => parseAllowedJids(''), ConfigError);
  assert.throws(() => parseAllowedJids('   '), ConfigError);
  assert.throws(() => parseAllowedJids('123456789-1@g.us'), ConfigError);
});

void test('buildConfig aplica defaults seguros', () => {
  const config = buildConfig(env({ ALLOWED_JIDS: '5521999999999' }));
  assert.equal(config.ephemeralSeconds, 604_800);
  assert.equal(config.cooldownMs, 24 * 60 * 60 * 1000);
  assert.equal(config.minDelayMs, 2 * 60 * 1000);
  assert.equal(config.maxDelayMs, 8 * 60 * 1000);
  assert.equal(config.openaiModel, 'gpt-4o-mini');
  assert.equal(config.openaiBaseUrl, 'https://api.openai.com/v1');
  assert.equal(config.openaiTimeoutMs, 8_000);
  assert.equal(config.openaiMaxRetries, 0);
  assert.equal(config.openaiTemperature, 1.05);
  assert.equal(config.openaiMaxTokens, 60);
  assert.equal(config.openaiApiKey, undefined);
});

void test('buildConfig valida EPHEMERAL_SECONDS', () => {
  for (const value of ['86400', '604800', '7776000']) {
    const config = buildConfig(
      env({ ALLOWED_JIDS: '5521999999999', EPHEMERAL_SECONDS: value }),
    );
    assert.equal(config.ephemeralSeconds, Number(value));
  }

  assert.throws(
    () => buildConfig(env({ ALLOWED_JIDS: '5521999999999', EPHEMERAL_SECONDS: '3600' })),
    /EPHEMERAL_SECONDS deve ser 86400, 604800 ou 7776000/,
  );
});

void test('buildConfig valida e aceita parametros da OpenAI', () => {
  const config = buildConfig(
    env({
      ALLOWED_JIDS: '5521999999999',
      OPENAI_MODEL: 'modelo-customizado',
      OPENAI_BASE_URL: 'https://example.com/v1/',
      OPENAI_TIMEOUT_MS: '15000',
      OPENAI_MAX_RETRIES: '3',
      OPENAI_TEMPERATURE: '0.4',
      OPENAI_MAX_TOKENS: '120',
    }),
  );
  assert.equal(config.openaiModel, 'modelo-customizado');
  assert.equal(config.openaiBaseUrl, 'https://example.com/v1');
  assert.equal(config.openaiTimeoutMs, 15_000);
  assert.equal(config.openaiMaxRetries, 3);
  assert.equal(config.openaiTemperature, 0.4);
  assert.equal(config.openaiMaxTokens, 120);

  assert.throws(
    () => buildConfig(env({ ALLOWED_JIDS: '5521999999999', OPENAI_BASE_URL: 'nao-e-url' })),
    /OPENAI_BASE_URL/,
  );
  assert.throws(
    () => buildConfig(env({ ALLOWED_JIDS: '5521999999999', OPENAI_BASE_URL: 'ftp://example.com' })),
    /OPENAI_BASE_URL/,
  );
  assert.throws(
    () => buildConfig(env({ ALLOWED_JIDS: '5521999999999', OPENAI_TIMEOUT_MS: '0' })),
    /OPENAI_TIMEOUT_MS/,
  );
  assert.throws(
    () => buildConfig(env({ ALLOWED_JIDS: '5521999999999', OPENAI_MAX_RETRIES: '11' })),
    /OPENAI_MAX_RETRIES/,
  );
  assert.throws(
    () => buildConfig(env({ ALLOWED_JIDS: '5521999999999', OPENAI_TEMPERATURE: '2.5' })),
    /OPENAI_TEMPERATURE/,
  );
  assert.throws(
    () => buildConfig(env({ ALLOWED_JIDS: '5521999999999', OPENAI_MAX_TOKENS: '0' })),
    /OPENAI_MAX_TOKENS/,
  );
});

void test('buildConfig valida delays e log level', () => {
  assert.throws(
    () =>
      buildConfig(
        env({
          ALLOWED_JIDS: '5521999999999',
          MIN_DELAY_MINUTES: '10',
          MAX_DELAY_MINUTES: '5',
        }),
      ),
    /MIN_DELAY_MINUTES/,
  );
  assert.throws(
    () => buildConfig(env({ ALLOWED_JIDS: '5521999999999', LOG_LEVEL: 'barulhento' })),
    /LOG_LEVEL/,
  );
});

void test('parseAllowedJids aceita wildcard "*" para monitorar todos', () => {
  const wildcard = parseAllowedJids('*');
  assert.equal(wildcard.has('*'), true);
});

void test('buildConfig aceita ALLOWED_JIDS="*" e EXCLUDED_JIDS', () => {
  const config = buildConfig(
    env({
      ALLOWED_JIDS: '*',
      EXCLUDED_JIDS: '5521999999999, 5521888888888',
    }),
  );
  assert.equal(config.allowAll, true);
  assert.equal(config.excludedJids.has('5521999999999@s.whatsapp.net'), true);
  assert.equal(config.excludedJids.has('5521888888888@s.whatsapp.net'), true);
});

void test('buildConfig assume allowAll quando apenas EXCLUDED_JIDS e fornecido', () => {
  const config = buildConfig(
    env({
      EXCLUDED_JIDS: '5521999999999',
    }),
  );
  assert.equal(config.allowAll, true);
  assert.equal(config.excludedJids.has('5521999999999@s.whatsapp.net'), true);
});

void test('isJidMonitored respeita allowAll e lista de exclusao', () => {
  const excluded = new Set(['5521999999999@s.whatsapp.net']);
  const allowed = new Set(['5521888888888@s.whatsapp.net']);

  // Modo allowAll com exclusão
  assert.equal(
    isJidMonitored('5521999999999@s.whatsapp.net', {
      allowAll: true,
      allowedJids: new Set(['*']),
      excludedJids: excluded,
    }),
    false,
  );
  assert.equal(
    isJidMonitored('5521777777777@s.whatsapp.net', {
      allowAll: true,
      allowedJids: new Set(['*']),
      excludedJids: excluded,
    }),
    true,
  );

  // Modo restrito (allowlist)
  assert.equal(
    isJidMonitored('5521888888888@s.whatsapp.net', {
      allowAll: false,
      allowedJids: allowed,
      excludedJids: new Set(),
    }),
    true,
  );
  assert.equal(
    isJidMonitored('5521777777777@s.whatsapp.net', {
      allowAll: false,
      allowedJids: allowed,
      excludedJids: new Set(),
    }),
    false,
  );

  // Mapeamento LID -> Telefone via resolveJid
  const resolver = (jid: string) => {
    if (jid === '123456789@lid') return '5521999999999@s.whatsapp.net';
    if (jid === '987654321@lid') return '5521888888888@s.whatsapp.net';
    return undefined;
  };

  // LID cujo telefone esta na lista de exclusao: deve ser excluido!
  assert.equal(
    isJidMonitored(
      '123456789@lid',
      {
        allowAll: true,
        allowedJids: new Set(['*']),
        excludedJids: excluded,
      },
      resolver,
    ),
    false,
  );

  // LID cujo telefone esta na allowlist: deve ser permitido!
  assert.equal(
    isJidMonitored(
      '987654321@lid',
      {
        allowAll: false,
        allowedJids: allowed,
        excludedJids: new Set(),
      },
      resolver,
    ),
    true,
  );
});
