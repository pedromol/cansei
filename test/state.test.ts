import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import pino from 'pino';
import { AuditLogger, StateError, StateStore } from '../src/state.js';

const logger = pino({ level: 'silent' });

async function temporaryDirectory(t: test.TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'cansei-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

void test('StateStore cria, atualiza e recarrega o estado', async (t) => {
  const directory = await temporaryDirectory(t);
  const file = path.join(directory, 'state.json');

  const store = new StateStore(file, logger);
  await store.load();

  const jid = '5521999999999@s.whatsapp.net';
  const updated = await store.update(jid, (current) => ({
    ...current,
    offCount: 2,
    pending: true,
    pendingUntil: '2026-01-01T00:10:00.000Z',
    lastKnownExpiration: 0,
  }));

  assert.equal(updated.offCount, 2);
  assert.equal(updated.pending, true);

  const reloaded = new StateStore(file, logger);
  await reloaded.load();
  assert.deepEqual(reloaded.get(jid), updated);
  assert.equal(reloaded.has('5521888888888@s.whatsapp.net'), false);
});

void test('StateStore serializa mutacoes concorrentes sem perder contagem', async (t) => {
  const directory = await temporaryDirectory(t);
  const store = new StateStore(path.join(directory, 'state.json'), logger);
  await store.load();

  const jid = '5521999999999@s.whatsapp.net';
  await Promise.all(
    Array.from({ length: 20 }, () =>
      store.update(jid, (current) => ({ ...current, offCount: current.offCount + 1 })),
    ),
  );

  assert.equal(store.get(jid).offCount, 20);
});

void test('StateStore preserva estado corrompido e falha de forma explicita', async (t) => {
  const directory = await temporaryDirectory(t);
  const file = path.join(directory, 'state.json');
  await writeFile(file, '{ nao e json', 'utf8');

  const store = new StateStore(file, logger);
  await assert.rejects(() => store.load(), StateError);

  const files = await readdir(directory);
  assert.ok(files.some((name) => name.startsWith('state.json.corrupt-')));
});

void test('StateStore rejeita versao desconhecida', async (t) => {
  const directory = await temporaryDirectory(t);
  const file = path.join(directory, 'state.json');
  await writeFile(
    file,
    JSON.stringify({ version: 99, updatedAt: new Date().toISOString(), contacts: {} }),
    'utf8',
  );

  const store = new StateStore(file, logger);
  await assert.rejects(() => store.load(), /Versao de estado nao suportada/);
});

void test('AuditLogger grava JSONL estruturado e flush aguarda a fila', async (t) => {
  const directory = await temporaryDirectory(t);
  const file = path.join(directory, 'audit.jsonl');
  const audit = new AuditLogger(file, logger);

  await audit.append({
    jid: '5521999999999@s.whatsapp.net',
    event: 'detected_disabled',
    detectedValue: 0,
    action: 'scheduled',
    counter: 0,
    details: { delayMs: 1000 },
  });
  await audit.append({
    jid: '5521999999999@s.whatsapp.net',
    event: 'reactivated',
    detectedValue: 0,
    action: 'reactivate',
    counter: 1,
  });
  await audit.flush();

  const lines = (await readFile(file, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 2);

  const first = JSON.parse(lines[0]!) as Record<string, unknown>;
  assert.equal(first.jid, '5521999999999@s.whatsapp.net');
  assert.equal(first.event, 'detected_disabled');
  assert.equal(first.detectedValue, 0);
  assert.equal(first.action, 'scheduled');
  assert.equal(first.counter, 0);
  assert.deepEqual(first.details, { delayMs: 1000 });
  assert.match(String(first.timestamp), /^\d{4}-\d{2}-\d{2}T/);

  const second = JSON.parse(lines[1]!) as Record<string, unknown>;
  assert.equal(second.details, undefined);
});
