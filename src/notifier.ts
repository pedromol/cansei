import type { Logger } from 'pino';
import type { AuditInput } from './state.js';

export interface TelegramNotifierOptions {
  botToken?: string;
  chatId?: string;
  logger?: Logger;
  fetchFn?: typeof fetch;
  resolveJid?: (jid: string) => string | undefined;
}

export function formatPhoneFromJid(jid: string): string {
  const isLid = jid.endsWith('@lid');
  const local = jid.split('@')[0] ?? '';
  const digits = local.replace(/\D/g, '');
  if (!digits) {
    return jid;
  }
  if (isLid) {
    return `LID: ${digits}`;
  }
  return `+${digits}`;
}

export class TelegramNotifier {
  private readonly botToken?: string;
  private readonly chatId?: string;
  private readonly logger?: Logger;
  private readonly fetchFn: typeof fetch;
  private readonly resolveJid?: (jid: string) => string | undefined;

  constructor(options: TelegramNotifierOptions = {}) {
    this.botToken = options.botToken?.trim();
    this.chatId = options.chatId?.trim();
    this.logger = options.logger;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.resolveJid = options.resolveJid;
  }

  get enabled(): boolean {
    return Boolean(this.botToken && this.chatId);
  }

  async send(text: string): Promise<boolean> {
    if (!this.enabled) {
      return false;
    }

    try {
      const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
      const response = await this.fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.chatId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger?.error(
          { status: response.status, body: errorText },
          'Falha ao enviar notificacao para o Telegram.',
        );
        return false;
      }
      return true;
    } catch (error) {
      this.logger?.error({ err: error }, 'Erro de conexao ao enviar notificacao ao Telegram.');
      return false;
    }
  }

  async notifyAuditEvent(input: AuditInput): Promise<boolean> {
    if (!this.enabled) {
      return false;
    }

    const resolvedJid = this.resolveJid ? this.resolveJid(input.jid) ?? input.jid : input.jid;
    const phone = formatPhoneFromJid(resolvedJid);
    let message = '';

    switch (input.event) {
      case 'detected_disabled': {
        const until = input.details?.pendingUntil
          ? new Date(String(input.details.pendingUntil)).toLocaleTimeString('pt-BR', {
              hour: '2-digit',
              minute: '2-digit',
            })
          : 'breve';
        message = [
          '⏳ <b>[Cansei] Desativação Detectada</b>',
          `<b>Contato:</b> <code>${phone}</code>`,
          `<b>Desativação nº:</b> ${input.counter + 1}`,
          `<b>Ação:</b> Reativação agendada para às ${until}`,
        ].join('\n');
        break;
      }

      case 'reactivated': {
        message = [
          '🔄 <b>[Cansei] Mensagens Reativadas</b>',
          `<b>Contato:</b> <code>${phone}</code>`,
          `<b>Contador de desativações:</b> ${input.counter}`,
          'Mensagens temporárias foram reativadas com sucesso.',
        ].join('\n');
        break;
      }

      case 'message_sent': {
        const phrase = input.details?.text ? String(input.details.text) : '';
        message = [
          '💬 <b>[Cansei] Aviso Enviado</b>',
          `<b>Contato:</b> <code>${phone}</code>`,
          phrase ? `<b>Frase:</b> <i>"${phrase}"</i>` : 'Aviso enviado ao contato.',
        ].join('\n');
        break;
      }

      case 'contact_blocked': {
        message = [
          '🚫 <b>[Cansei] Contato Bloqueado</b>',
          `<b>Contato:</b> <code>${phone}</code>`,
          `<b>Motivo:</b> Limite de desativações atingido (${input.counter}ª vez). Contato foi bloqueado.`,
        ].join('\n');
        break;
      }

      case 'action_cancelled': {
        message = [
          '✅ <b>[Cansei] Ação Cancelada</b>',
          `<b>Contato:</b> <code>${phone}</code>`,
          'O contato reativou as mensagens temporárias antes do prazo. Nenhuma penalidade aplicada.',
        ].join('\n');
        break;
      }

      case 'action_failed':
      case 'block_failed':
      case 'message_failed': {
        message = [
          '⚠️ <b>[Cansei] Falha na Ação</b>',
          `<b>Contato:</b> <code>${phone}</code>`,
          `<b>Evento:</b> ${input.event}`,
          input.details?.error ? `<b>Erro:</b> ${input.details.error}` : '',
        ]
          .filter(Boolean)
          .join('\n');
        break;
      }

      case 'blocked_externally': {
        message = [
          'ℹ️ <b>[Cansei] Bloqueado Externamente</b>',
          `<b>Contato:</b> <code>${phone}</code>`,
          'Contato já consta na blocklist do WhatsApp.',
        ].join('\n');
        break;
      }

      default:
        return false;
    }

    return this.send(message);
  }
}
