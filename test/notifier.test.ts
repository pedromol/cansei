import assert from 'node:assert/strict';
import test from 'node:test';
import { TelegramNotifier, formatPhoneFromJid } from '../src/notifier.js';

void test('formatPhoneFromJid formata jid individual corretamente', () => {
  assert.equal(formatPhoneFromJid('5521999999999@s.whatsapp.net'), '+5521999999999');
  assert.equal(formatPhoneFromJid('5521999999999'), '+5521999999999');
});

void test('TelegramNotifier nao envia quando desabilitado', async () => {
  const notifier = new TelegramNotifier();
  assert.equal(notifier.enabled, false);
  assert.equal(await notifier.send('teste'), false);
  assert.equal(
    await notifier.notifyAuditEvent({
      jid: '5521999999999@s.whatsapp.net',
      event: 'detected_disabled',
      action: 'scheduled',
      counter: 0,
      detectedValue: 0,
    }),
    false,
  );
});

void test('TelegramNotifier envia payload correto para api do Telegram', async () => {
  const sentRequests: Array<{ url: string; body: string }> = [];

  const mockFetch = async (input: unknown, init?: { body?: unknown }) => {
    sentRequests.push({
      url: String(input),
      body: String(init?.body),
    });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const notifier = new TelegramNotifier({
    botToken: '123456:ABC-DEF',
    chatId: '987654321',
    fetchFn: mockFetch as typeof fetch,
  });

  assert.equal(notifier.enabled, true);

  // Teste evento detected_disabled
  const resultDisabled = await notifier.notifyAuditEvent({
    jid: '5521999999999@s.whatsapp.net',
    event: 'detected_disabled',
    action: 'scheduled',
    counter: 0,
    detectedValue: 0,
    details: { pendingUntil: '2026-01-01T12:30:00.000Z' },
  });
  assert.equal(resultDisabled, true);
  assert.equal(sentRequests.length, 1);
  assert.ok(sentRequests[0]?.url.includes('123456:ABC-DEF/sendMessage'));
  assert.ok(sentRequests[0]?.body.includes('5521999999999'));
  assert.ok(sentRequests[0]?.body.includes('Desativação Detectada'));

  // Teste evento reactivated
  await notifier.notifyAuditEvent({
    jid: '5521999999999@s.whatsapp.net',
    event: 'reactivated',
    action: 'reactivate',
    counter: 1,
    detectedValue: 0,
  });
  assert.equal(sentRequests.length, 2);
  assert.ok(sentRequests[1]?.body.includes('Mensagens Reativadas'));

  // Teste evento message_sent
  await notifier.notifyAuditEvent({
    jid: '5521999999999@s.whatsapp.net',
    event: 'message_sent',
    action: 'send_message',
    counter: 2,
    detectedValue: 0,
    details: { text: 'Prefiro manter ativado' },
  });
  assert.equal(sentRequests.length, 3);
  assert.ok(sentRequests[2]?.body.includes('Aviso Enviado'));
  assert.ok(sentRequests[2]?.body.includes('Prefiro manter ativado'));

  // Teste evento contact_blocked
  await notifier.notifyAuditEvent({
    jid: '5521999999999@s.whatsapp.net',
    event: 'contact_blocked',
    action: 'block',
    counter: 3,
    detectedValue: 0,
  });
  assert.equal(sentRequests.length, 4);
  assert.ok(sentRequests[3]?.body.includes('Contato Bloqueado'));

  // Teste evento action_cancelled
  await notifier.notifyAuditEvent({
    jid: '5521999999999@s.whatsapp.net',
    event: 'action_cancelled',
    action: 'cancelled',
    counter: 0,
    detectedValue: 0,
  });
  assert.equal(sentRequests.length, 5);
  assert.ok(sentRequests[4]?.body.includes('Ação Cancelada'));
});
