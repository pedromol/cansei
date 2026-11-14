import assert from 'node:assert/strict';
import test from 'node:test';
import pino from 'pino';
import {
  FALLBACK_MESSAGES,
  MAX_MESSAGE_WORDS,
  MessageGenerator,
  countWords,
  sanitizeMessage,
} from '../src/llm.js';

const logger = pino({ level: 'silent' });
const first = <T,>(items: readonly T[]): T => items[0]!;

void test('mensagens fallback respeitam o limite de 18 palavras', () => {
  for (const message of FALLBACK_MESSAGES) {
    assert.ok(countWords(message) <= MAX_MESSAGE_WORDS, message);
    assert.ok(sanitizeMessage(message) !== null, message);
  }
});

void test('sanitizeMessage aceita uma frase segura e curta', () => {
  assert.equal(
    sanitizeMessage('  "Prefiro manter as mensagens temporárias ativadas."  '),
    'Prefiro manter as mensagens temporárias ativadas.',
  );
});

void test('sanitizeMessage usa apenas a primeira linha e a primeira frase', () => {
  assert.equal(
    sanitizeMessage('Prefiro manter as temporárias ativadas.\nSegunda linha.'),
    'Prefiro manter as temporárias ativadas.',
  );
});

void test('sanitizeMessage rejeita frases longas, conteudo proibido e acusacao', () => {
  const long = Array.from({ length: 26 }, (_, index) => `palavra${index}`).join(' ');
  assert.equal(sanitizeMessage(long), null);
  assert.equal(sanitizeMessage('Vou fazer uma ameaça para você.'), null);
  assert.equal(sanitizeMessage('Você desativou as mensagens de novo.'), null);
  assert.equal(sanitizeMessage('   '), null);
});

void test('MessageGenerator usa fallback quando a OpenAI nao esta configurada', async () => {
  const generator = new MessageGenerator({
    model: 'gpt-4o-mini',
    logger,
    pick: first,
  });

  const result = await generator.generate();
  assert.equal(result.source, 'fallback');
  assert.equal(result.text, FALLBACK_MESSAGES[0]);
});

void test('MessageGenerator usa a resposta valida do LLM', async () => {
  const generator = new MessageGenerator({
    model: 'test',
    logger,
    pick: first,
    complete: async () => 'Prefiro manter as mensagens temporárias ativadas por aqui.',
  });

  const result = await generator.generate();
  assert.equal(result.source, 'llm');
  assert.equal(result.text, 'Prefiro manter as mensagens temporárias ativadas por aqui.');
});

void test('MessageGenerator cai no fallback em resposta invalida ou falha', async () => {
  const invalid = new MessageGenerator({
    model: 'test',
    logger,
    pick: first,
    complete: async () => 'Vou te bloquear e denunciar agora mesmo.',
  });
  assert.deepEqual(await invalid.generate(), {
    text: FALLBACK_MESSAGES[0],
    source: 'fallback',
  });

  const failing = new MessageGenerator({
    model: 'test',
    logger,
    pick: first,
    complete: async () => {
      throw new Error('timeout');
    },
  });
  assert.deepEqual(await failing.generate(), {
    text: FALLBACK_MESSAGES[0],
    source: 'fallback',
  });
});
