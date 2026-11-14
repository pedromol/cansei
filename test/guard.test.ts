import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import pino from 'pino';
import type { GuardActions, GuardConfig, Scheduled, Scheduler } from '../src/guard.js';
import { EphemeralGuard } from '../src/guard.js';
import { MessageGenerator } from '../src/llm.js';
import { AuditLogger, StateStore, type ContactState } from '../src/state.js';

const logger = pino({ level: 'silent' });
const JID = '5521999999999@s.whatsapp.net';
const START = Date.parse('2026-01-01T00:00:00.000Z');
const first = <T,>(items: readonly T[]): T => items[0]!;

class ManualScheduler implements Scheduler {
  private tasks: Array<{ callback: () => void; cancelled: boolean }> = [];

  schedule(callback: () => void, _delayMs: number): Scheduled {
    const task = { callback, cancelled: false };
    this.tasks.push(task);
    return {
      cancel: () => {
        task.cancelled = true;
      },
    };
  }

  runAll(): void {
    const tasks = this.tasks;
    this.tasks = [];
    for (const task of tasks) {
      if (!task.cancelled) {
        task.callback();
      }
    }
  }

  get pending(): number {
    return this.tasks.filter((task) => !task.cancelled).length;
  }
}

interface HarnessOptions {
  contact?: Partial<ContactState>;
  fail?: { ephemeral?: boolean; text?: boolean; block?: boolean };
  callInit?: boolean;
  cooldownMs?: number;
  config?: Partial<GuardConfig>;
}

async function createHarness(t: TestContext, options: HarnessOptions = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'cansei-guard-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const state = new StateStore(path.join(directory, 'state.json'), logger);
  await state.load();

  if (options.contact) {
    await state.update(JID, (current) => ({ ...current, ...options.contact }));
  }

  const auditPath = path.join(directory, 'audit.jsonl');
  const audit = new AuditLogger(auditPath, logger);
  const scheduler = new ManualScheduler();
  const clock = { now: START };

  const calls = {
    ephemeral: [] as Array<{ jid: string; seconds: number }>,
    texts: [] as Array<{ jid: string; text: string }>,
    blocks: [] as string[],
  };

  const actions: GuardActions = {
    async setEphemeral(jid, seconds) {
      if (options.fail?.ephemeral) {
        throw new Error('falha ao reativar');
      }
      calls.ephemeral.push({ jid, seconds });
    },
    async sendText(jid, text) {
      if (options.fail?.text) {
        throw new Error('falha ao enviar');
      }
      calls.texts.push({ jid, text });
    },
    async block(jid) {
      if (options.fail?.block) {
        throw new Error('falha ao bloquear');
      }
      calls.blocks.push(jid);
    },
  };

  const messages = new MessageGenerator({
    model: 'test',
    logger,
    pick: first,
    complete: async () => 'Prefiro manter as mensagens temporárias ativadas por aqui.',
  });

  const config: GuardConfig = {
    allowedJids: new Set([JID]),
    excludedJids: new Set(),
    allowAll: false,
    ephemeralSeconds: 604_800,
    cooldownMs: options.cooldownMs ?? 60 * 60 * 1000,
    minDelayMs: 10_000,
    maxDelayMs: 10_000,
    ...options.config,
  };

  const guard = new EphemeralGuard({
    config,
    state,
    audit,
    messages,
    actions,
    logger,
    scheduler,
    now: () => clock.now,
    randomDelayMs: () => 10_000,
    dedupeWindowMs: 10_000,
    reconnectSettleMs: 0,
  });

  if (options.callInit) {
    await guard.init();
  }

  return { directory, state, audit, auditPath, scheduler, calls, clock, guard, config };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('Tempo esgotado aguardando a condicao.');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function readAudit(file: string): Promise<Array<Record<string, unknown>>> {
  let content = '';
  try {
    content = (await readFile(file, 'utf8')).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  if (!content) {
    return [];
  }
  return content.split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
}

function eventNames(entries: Array<Record<string, unknown>>): string[] {
  return entries.map((entry) => String(entry.event));
}

void test('ignora grupos, LIDs e contatos fora da allowlist', async (t) => {
  const harness = await createHarness(t);

  await harness.guard.observe('123456789-987654@g.us', 0, 'update');
  await harness.guard.observe('123456789@lid', 0, 'update');
  await harness.guard.observe('5521888888888', 0, 'update');

  await harness.audit.flush();
  assert.equal(harness.scheduler.pending, 0);
  assert.equal(harness.state.has(JID), false);
  assert.deepEqual(await readAudit(harness.auditPath), []);
});

void test('primeira desativacao reativa instantaneamente em silencio', async (t) => {
  const harness = await createHarness(t);

  await harness.guard.observe(JID, 0, 'update');

  const contact = harness.state.get(JID);
  assert.equal(contact.pending, false);
  assert.equal(contact.offCount, 1);
  assert.equal(contact.lastOffAt, new Date(START).toISOString());
  assert.equal(harness.scheduler.pending, 0);

  await harness.audit.flush();

  assert.equal(contact.cooldownUntil, new Date(START + 3_600_000).toISOString());
  assert.equal(harness.calls.ephemeral.length, 1);
  assert.equal(harness.calls.ephemeral[0]?.seconds, 604_800);
  assert.equal(harness.calls.texts.length, 0);
  assert.equal(harness.calls.blocks.length, 0);

  const events = eventNames(await readAudit(harness.auditPath));
  assert.deepEqual(events, ['reactivated']);
});

void test('contato que reativa antes do delay cancela sem incrementar', async (t) => {
  const harness = await createHarness(t, {
    contact: {
      offCount: 1,
      lastKnownExpiration: 604_800,
      cooldownUntil: new Date(START - 1_000).toISOString(),
    },
  });

  await harness.guard.observe(JID, 0, 'update');
  assert.equal(harness.scheduler.pending, 1);
  assert.equal(harness.calls.texts.length, 1);

  await harness.guard.observe(JID, 604_800, 'update');

  const contact = harness.state.get(JID);
  assert.equal(contact.pending, false);
  assert.equal(contact.lastKnownExpiration, 604_800);
  assert.equal(harness.scheduler.pending, 0);

  harness.scheduler.runAll();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await harness.audit.flush();

  assert.equal(harness.calls.ephemeral.length, 0);
  assert.ok(eventNames(await readAudit(harness.auditPath)).includes('action_cancelled'));
});

void test('cooldown bloqueia novo evento do mesmo contato', async (t) => {
  const harness = await createHarness(t);

  await harness.guard.observe(JID, 0, 'update');
  await waitFor(() => harness.state.get(JID).offCount === 1);

  harness.clock.now = START + 31 * 60 * 1000;
  await harness.guard.observe(JID, 0, 'update');
  await harness.audit.flush();

  const contact = harness.state.get(JID);
  assert.equal(contact.pending, false);
  assert.equal(contact.offCount, 1);
  assert.equal(harness.scheduler.pending, 0);
  assert.ok(eventNames(await readAudit(harness.auditPath)).includes('skipped_cooldown'));
});

void test('segunda desativacao envia mensagem instantanea e reativa apos delay', async (t) => {
  const harness = await createHarness(t, {
    contact: {
      offCount: 1,
      lastKnownExpiration: 604_800,
      cooldownUntil: new Date(START - 1_000).toISOString(),
    },
  });

  await harness.guard.observe(JID, 0, 'update');

  assert.equal(harness.calls.texts.length, 1);
  assert.equal(harness.calls.ephemeral.length, 0);
  assert.equal(harness.scheduler.pending, 1);

  harness.scheduler.runAll();
  await waitFor(() => harness.state.get(JID).pending === false);
  await harness.audit.flush();

  assert.equal(harness.calls.ephemeral.length, 1);
  assert.equal(harness.calls.ephemeral[0]?.seconds, 604_800);
  assert.equal(harness.calls.blocks.length, 0);
  assert.equal(harness.state.get(JID).blocked, false);
  assert.equal(harness.state.get(JID).offCount, 2);

  const entries = await readAudit(harness.auditPath);
  const messageSent = entries.find((entry) => entry.event === 'message_sent');
  assert.equal((messageSent?.details as Record<string, unknown>).source, 'llm');
});

void test('terceira desativacao envia mensagem, reativa e bloqueia instantaneamente', async (t) => {
  const harness = await createHarness(t, {
    contact: {
      offCount: 2,
      lastKnownExpiration: 604_800,
      cooldownUntil: new Date(START - 1_000).toISOString(),
    },
  });

  await harness.guard.observe(JID, 0, 'update');

  assert.equal(harness.scheduler.pending, 0);
  assert.equal(harness.calls.texts.length, 1);
  assert.equal(harness.calls.ephemeral.length, 1);
  assert.deepEqual(harness.calls.blocks, [JID]);

  await harness.audit.flush();

  const contact = harness.state.get(JID);
  assert.equal(contact.offCount, 3);
  assert.equal(contact.blocked, true);
  assert.ok(contact.blockedAt);
  assert.ok(eventNames(await readAudit(harness.auditPath)).includes('contact_blocked'));
});

void test('nunca age em contato ja bloqueado', async (t) => {
  const harness = await createHarness(t, {
    contact: {
      offCount: 3,
      blocked: true,
      blockedAt: new Date(START - 10_000).toISOString(),
      lastKnownExpiration: 0,
      cooldownUntil: new Date(START - 1_000).toISOString(),
    },
  });

  await harness.guard.observe(JID, 0, 'update');
  await harness.audit.flush();

  assert.equal(harness.scheduler.pending, 0);
  assert.equal(harness.calls.ephemeral.length, 0);
  assert.equal(harness.calls.texts.length, 0);
  assert.equal(harness.calls.blocks.length, 0);
  assert.ok(eventNames(await readAudit(harness.auditPath)).includes('skipped_blocked'));
});

void test('reavalia antes de agir e cancela se o estado mudou', async (t) => {
  const harness = await createHarness(t, {
    contact: {
      offCount: 1,
      lastKnownExpiration: 604_800,
      cooldownUntil: new Date(START - 1_000).toISOString(),
    },
  });

  await harness.guard.observe(JID, 0, 'update');
  await harness.state.update(JID, (current) => ({
    ...current,
    lastKnownExpiration: 604_800,
  }));

  harness.scheduler.runAll();
  await waitFor(() => harness.state.get(JID).pending === false);
  await harness.audit.flush();

  assert.equal(harness.calls.ephemeral.length, 0);

  const entries = await readAudit(harness.auditPath);
  const cancelled = entries.find((entry) => entry.event === 'action_cancelled');
  assert.equal(
    (cancelled?.details as Record<string, unknown>).reason,
    'ephemeral_reenabled_before_action',
  );
});

void test('retoma acao pendente apos reinicializacao', async (t) => {
  const pendingUntil = new Date(START + 5_000).toISOString();
  const harness = await createHarness(t, {
    callInit: true,
    contact: {
      offCount: 1,
      pending: true,
      pendingUntil,
      lastKnownExpiration: 0,
      lastOffAt: new Date(START - 1_000).toISOString(),
      cooldownUntil: new Date(START - 1_000).toISOString(),
    },
  });

  await harness.audit.flush();
  assert.ok(eventNames(await readAudit(harness.auditPath)).includes('pending_resumed'));
  assert.equal(harness.scheduler.pending, 1);

  harness.scheduler.runAll();
  await waitFor(() => harness.state.get(JID).offCount === 2);
  await harness.audit.flush();

  assert.equal(harness.calls.ephemeral.length, 1);
  assert.equal(harness.calls.texts.length, 0);
});

void test('inicializacao cancela pending se o ultimo estado nao era desativado', async (t) => {
  const harness = await createHarness(t, {
    callInit: true,
    contact: {
      pending: true,
      pendingUntil: new Date(START + 5_000).toISOString(),
      lastKnownExpiration: 604_800,
    },
  });

  await harness.audit.flush();

  assert.equal(harness.scheduler.pending, 0);
  assert.equal(harness.state.get(JID).pending, false);
  assert.ok(eventNames(await readAudit(harness.auditPath)).includes('action_cancelled'));
});

void test('deduplica eventos proximos e ignora novo evento enquanto pending', async (t) => {
  const harness = await createHarness(t, {
    contact: {
      offCount: 1,
      lastKnownExpiration: 604_800,
      cooldownUntil: new Date(START - 1_000).toISOString(),
    },
  });

  await harness.guard.observe(JID, 0, 'update');
  await harness.guard.observe(JID, 0, 'update');

  assert.equal(harness.scheduler.pending, 1);

  harness.clock.now = START + 11_000;
  await harness.guard.observe(JID, 0, 'update');
  await harness.audit.flush();

  const events = eventNames(await readAudit(harness.auditPath));
  assert.equal(events.filter((event) => event === 'detected_disabled').length, 1);
  assert.ok(events.includes('skipped_pending'));
  assert.equal(harness.scheduler.pending, 1);
});

void test('falha ao reativar na primeira vez registra action_failed e nao incrementa contador', async (t) => {
  const harness = await createHarness(t, { fail: { ephemeral: true } });

  await harness.guard.observe(JID, 0, 'update');
  await harness.audit.flush();

  const contact = harness.state.get(JID);
  assert.equal(contact.offCount, 0);
  assert.equal(harness.calls.texts.length, 0);
  assert.equal(harness.calls.blocks.length, 0);

  const entries = await readAudit(harness.auditPath);
  const failed = entries.find((entry) => entry.event === 'action_failed');
  assert.equal((failed?.details as Record<string, unknown>).stage, 'reactivate_instant');
});

void test('falha no envio da mensagem nao desfaz a reativacao', async (t) => {
  const harness = await createHarness(t, {
    fail: { text: true },
    contact: {
      offCount: 1,
      lastKnownExpiration: 0,
      cooldownUntil: new Date(START - 1_000).toISOString(),
    },
  });

  await harness.guard.observe(JID, 0, 'update');
  harness.scheduler.runAll();
  await waitFor(() => harness.state.get(JID).offCount === 2);
  await harness.audit.flush();

  assert.equal(harness.state.get(JID).pending, false);
  assert.equal(harness.calls.ephemeral.length, 1);
  assert.ok(eventNames(await readAudit(harness.auditPath)).includes('message_failed'));
});

void test('falha no bloqueio e registrada sem marcar o contato como bloqueado', async (t) => {
  const harness = await createHarness(t, {
    fail: { block: true },
    contact: {
      offCount: 2,
      lastKnownExpiration: 0,
      cooldownUntil: new Date(START - 1_000).toISOString(),
    },
  });

  await harness.guard.observe(JID, 0, 'update');
  harness.scheduler.runAll();
  await waitFor(() => harness.state.get(JID).offCount === 3);
  await harness.audit.flush();

  assert.equal(harness.state.get(JID).blocked, false);
  const entries = await readAudit(harness.auditPath);
  assert.ok(entries.some((entry) => entry.event === 'block_failed'));});

void test('sincroniza bloqueio externo apenas para contatos da allowlist', async (t) => {
  const harness = await createHarness(t);

  await harness.guard.syncBlocked([JID, '5521888888888@s.whatsapp.net']);
  await harness.audit.flush();

  assert.equal(harness.state.get(JID).blocked, true);
  assert.equal(harness.state.has('5521888888888@s.whatsapp.net'), false);
  assert.ok(eventNames(await readAudit(harness.auditPath)).includes('blocked_externally'));
});

void test('modo allowAll monitora contatos individuais e ignora quem esta em excludedJids', async (t) => {
  const EXCLUDED_JID = '5521777777777@s.whatsapp.net';
  const OTHER_JID = '5521888888888@s.whatsapp.net';

  const harness = await createHarness(t, {
    config: {
      allowAll: true,
      allowedJids: new Set(['*']),
      excludedJids: new Set([EXCLUDED_JID]),
    },
  });

  // Contato excluído desativa: deve ser ignorado
  await harness.guard.observe(EXCLUDED_JID, 0, 'update');
  assert.equal(harness.scheduler.pending, 0);
  assert.equal(harness.state.has(EXCLUDED_JID), false);

  // Outro contato desativa: deve ser monitorado e revertido instantaneamente
  await harness.guard.observe(OTHER_JID, 0, 'update');
  await waitFor(() => harness.state.get(OTHER_JID).offCount === 1);
  await harness.audit.flush();
  assert.equal(harness.calls.ephemeral.length, 1);
  assert.equal(harness.calls.ephemeral[0]?.jid, OTHER_JID);
});

test('trata expiration null vindo do Baileys como desativacao (0)', async (t) => {
  const harness = await createHarness(t);

  await harness.guard.observe(JID, null, 'update');
  await waitFor(() => harness.state.get(JID).offCount === 1);
  await harness.audit.flush();
  assert.equal(harness.calls.ephemeral.length, 1);
  assert.equal(harness.state.get(JID).lastKnownExpiration, 604_800);
});

test('ensureEnabledOnMessage ativa 7 dias automaticamente em mensagem de chat sem efemero sem penalizar', async (t) => {
  const harness = await createHarness(t);

  // Mensagem normal recebida de chat legado sem efemero (expiration: 0)
  await harness.guard.ensureEnabledOnMessage(JID, 0);
  await harness.audit.flush();

  // Deve ter ativado 7 dias (604800)
  assert.equal(harness.calls.ephemeral.length, 1);
  assert.equal(harness.calls.ephemeral[0]?.jid, JID);
  assert.equal(harness.calls.ephemeral[0]?.seconds, 604_800);

  // Nao deve ter penalizado o contato (offCount permanece 0)
  assert.equal(harness.state.get(JID).offCount, 0);
  assert.equal(harness.state.get(JID).lastKnownExpiration, 604_800);

  const auditEvents = eventNames(await readAudit(harness.auditPath));
  assert.ok(auditEvents.includes('auto_enabled_on_message'));
});

test('ensureEnabledOnMessage nao faz nada se o chat ja tem 7 dias ativo', async (t) => {
  const harness = await createHarness(t, {
    contact: { lastKnownExpiration: 604_800 },
  });

  await harness.guard.ensureEnabledOnMessage(JID, 0);
  await harness.audit.flush();

  // Nao deve chamar setEphemeral novamente
  assert.equal(harness.calls.ephemeral.length, 0);
});

test('ensureEnabledOnMessage ignora contatos da lista de exclusao', async (t) => {
  const EXCLUDED_JID = '5521777777777@s.whatsapp.net';
  const harness = await createHarness(t, {
    config: {
      allowAll: true,
      allowedJids: new Set(['*']),
      excludedJids: new Set([EXCLUDED_JID]),
    },
  });

  await harness.guard.ensureEnabledOnMessage(EXCLUDED_JID, 0);
  await harness.audit.flush();

  assert.equal(harness.calls.ephemeral.length, 0);
  assert.equal(harness.state.has(EXCLUDED_JID), false);
});
