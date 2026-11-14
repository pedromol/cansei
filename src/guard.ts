import { randomInt } from 'node:crypto';
import type { Logger } from 'pino';
import { type AppConfig, isJidMonitored, normalizeIndividualJid } from './config.js';
import { countWords, type MessageGenerator } from './llm.js';
import type { TelegramNotifier } from './notifier.js';
import type { AuditLogger, AuditInput, ContactState, StateStore } from './state.js';

export type ObserveSource = 'update' | 'history' | 'upsert';

export interface GuardActions {
  setEphemeral(jid: string, seconds: number): Promise<void>;
  sendText(jid: string, text: string): Promise<void>;
  block(jid: string): Promise<void>;
}

export interface Scheduled {
  cancel(): void;
}

export interface Scheduler {
  schedule(callback: () => void, delayMs: number): Scheduled;
}

export type GuardConfig = Pick<
  AppConfig,
  | 'allowedJids'
  | 'excludedJids'
  | 'allowAll'
  | 'ephemeralSeconds'
  | 'cooldownMs'
  | 'minDelayMs'
  | 'maxDelayMs'
>;

export interface EphemeralGuardOptions {
  config: GuardConfig;
  state: StateStore;
  audit: AuditLogger;
  messages: MessageGenerator;
  actions: GuardActions;
  notifier?: TelegramNotifier;
  logger: Logger;
  resolveJid?: (jid: string) => string | undefined;
  scheduler?: Scheduler;
  now?: () => number;
  randomDelayMs?: (minMs: number, maxMs: number) => number;
  dedupeWindowMs?: number;
  reconnectSettleMs?: number;
}

const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * setTimeout com divisao em blocos, para delays maiores que o limite do Node.
 */
export function createTimeoutScheduler(): Scheduler {
  return {
    schedule(callback: () => void, delayMs: number): Scheduled {
      let cancelled = false;
      let timer: NodeJS.Timeout | undefined;

      const arm = (remainingMs: number): void => {
        const chunk = Math.min(Math.max(0, Math.floor(remainingMs)), MAX_TIMEOUT_MS);
        timer = setTimeout(() => {
          if (cancelled) {
            return;
          }
          if (remainingMs > chunk) {
            arm(remainingMs - chunk);
          } else {
            callback();
          }
        }, chunk);
      };

      arm(delayMs);

      return {
        cancel(): void {
          cancelled = true;
          if (timer) {
            clearTimeout(timer);
          }
        },
      };
    },
  };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function isFuture(value: string | null, nowMs: number): boolean {
  if (!value) {
    return false;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > nowMs;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function maskJid(jid: string): string {
  const local = jid.split('@')[0] ?? '';
  return `${local.slice(0, 4)}***@s.whatsapp.net`;
}

function defaultRandomDelay(minMs: number, maxMs: number): number {
  if (maxMs <= minMs) {
    return Math.max(0, minMs);
  }
  return randomInt(minMs, maxMs + 1);
}

/**
 * Regras de negocio do monitor. Toda interacao externa com o WhatsApp e
 * injetada via GuardActions, o que mantem esta classe testavel e independente
 * dos detalhes nao oficiais do Baileys.
 */
export class EphemeralGuard {
  private readonly scheduler: Scheduler;
  private readonly now: () => number;
  private readonly randomDelayMs: (minMs: number, maxMs: number) => number;
  private readonly dedupeWindowMs: number;
  private readonly reconnectSettleMs: number;

  private readonly timers = new Map<string, Scheduled>();
  private readonly executing = new Set<string>();
  private readonly lastEventAt = new Map<string, number>();
  private stopped = false;

  constructor(private readonly options: EphemeralGuardOptions) {
    this.scheduler = options.scheduler ?? createTimeoutScheduler();
    this.now = options.now ?? Date.now;
    this.randomDelayMs = options.randomDelayMs ?? defaultRandomDelay;
    this.dedupeWindowMs = options.dedupeWindowMs ?? 10_000;
    this.reconnectSettleMs = options.reconnectSettleMs ?? 15_000;
  }

  /**
   * Retoma acoes pendentes apos uma reinicializacao. Antes de agir, exige que
   * o ultimo estado conhecido ainda seja "desativado" (0).
   */
  async init(): Promise<void> {
    const now = this.now();

    for (const contact of this.options.state.all()) {
      if (!contact.pending) {
        continue;
      }

      if (contact.blocked) {
        await this.cancelPending(contact.jid, 'blocked', contact.offCount);
        continue;
      }

      if (contact.lastKnownExpiration !== 0) {
        await this.cancelPending(
          contact.jid,
          'not_confirmed_disabled_after_restart',
          contact.offCount,
        );
        continue;
      }

      const dueAt = contact.pendingUntil ? Date.parse(contact.pendingUntil) : Number.NaN;
      const remaining = Number.isFinite(dueAt) ? dueAt - now : 0;
      const delayMs = Math.max(this.reconnectSettleMs, remaining, 0);

      this.schedule(contact.jid, delayMs);
      await this.record({
        jid: contact.jid,
        event: 'pending_resumed',
        detectedValue: 0,
        action: 'resumed',
        counter: contact.offCount,
        details: { delayMs },
      });
    }
  }

  /**
   * Observa um valor de ephemeralExpiration vindo do Baileys. Somente
   * `chats.update` pode iniciar uma reacao; historico e upsert apenas
   * atualizam o ultimo valor conhecido (usado na reavaliacao).
   */
  async observe(
    rawJid: string,
    expiration: number | null | undefined,
    source: ObserveSource,
    observedAt = this.now(),
  ): Promise<void> {
    const jid = normalizeIndividualJid(rawJid);
    if (!jid) {
      this.options.logger.debug(
        { jid: rawJid },
        'JID ignorado: apenas contatos individuais sao suportados.',
      );
      return;
    }

    if (!isJidMonitored(jid, this.options.config, this.options.resolveJid)) {
      this.options.logger.debug({ jid: maskJid(jid) }, 'JID fora do monitoramento ou na lista de exclusao; ignorado.');
      return;
    }

    if (expiration === 0 || expiration === null) {
      if (source === 'update') {
        await this.handleDisabled(jid, observedAt);
      } else {
        await this.remember(jid, 0);
      }
      return;
    }

    if (typeof expiration === 'number' && Number.isFinite(expiration) && expiration > 0) {
      await this.handleEnabled(jid, expiration, observedAt);
    }
  }

  /**
   * Chamado quando uma mensagem normal e recebida de um contato.
   * Se o chat atual nao tem mensagens temporarias ativadas, ativa 7 dias
   * automaticamente em silencio, sem aplicar penalidade ou incrementar contagem.
   */
  async ensureEnabledOnMessage(
    rawJid: string,
    expiration: number,
    observedAt = this.now(),
  ): Promise<void> {
    const jid = normalizeIndividualJid(rawJid);
    if (!jid || !isJidMonitored(jid, this.options.config, this.options.resolveJid)) {
      return;
    }

    if (expiration > 0) {
      await this.remember(jid, expiration);
      return;
    }

    const state = this.options.state.get(jid);
    if (state.blocked || state.pending || this.executing.has(jid) || this.timers.has(jid)) {
      return;
    }

    if (state.lastKnownExpiration === this.options.config.ephemeralSeconds) {
      return;
    }

    const now = this.now();
    const previousEventAt = this.lastEventAt.get(jid);
    if (previousEventAt !== undefined && now - previousEventAt < this.dedupeWindowMs) {
      return;
    }
    this.lastEventAt.set(jid, now);

    this.options.logger.info(
      { jid: maskJid(jid) },
      'Chat existente sem mensagens temporarias detectado ao receber mensagem; ativando 7 dias automaticamente.',
    );

    try {
      await this.options.actions.setEphemeral(jid, this.options.config.ephemeralSeconds);
      await this.options.state.update(jid, (current) => ({
        ...current,
        lastKnownExpiration: this.options.config.ephemeralSeconds,
      }));
      await this.record({
        jid,
        event: 'auto_enabled_on_message',
        detectedValue: 0,
        action: 'reactivate',
        counter: state.offCount,
        details: { ephemeralSeconds: this.options.config.ephemeralSeconds },
      });
    } catch (error) {
      this.options.logger.error(
        { err: describeError(error), jid: maskJid(jid) },
        'Falha ao ativar mensagens temporarias em chat legado.',
      );
    }
  }

  /**
   * Ao reconectar, da uma pequena janela para o WhatsApp reenviar o estado
   * dos chats antes de executar uma acao ja agendada.
   */
  async onConnectionOpen(): Promise<void> {
    const now = this.now();

    for (const contact of this.options.state.all()) {
      if (!contact.pending || contact.blocked || this.executing.has(contact.jid)) {
        continue;
      }

      const dueAt = contact.pendingUntil ? Date.parse(contact.pendingUntil) : Number.NaN;
      if (!Number.isFinite(dueAt)) {
        continue;
      }

      const remaining = dueAt - now;
      if (remaining >= this.reconnectSettleMs) {
        continue;
      }

      const delayMs = this.reconnectSettleMs;
      const pendingUntil = iso(now + delayMs);
      try {
        await this.options.state.update(contact.jid, (current) => ({
          ...current,
          pendingUntil,
        }));
      } catch (error) {
        this.options.logger.error(
          { err: describeError(error), jid: maskJid(contact.jid) },
          'Falha ao remarcar acao pendente para reavaliacao.',
        );
        continue;
      }

      this.schedule(contact.jid, delayMs);
      await this.record({
        jid: contact.jid,
        event: 'pending_rescheduled',
        detectedValue: 0,
        action: 'rescheduled',
        counter: contact.offCount,
        details: { delayMs, reason: 'connection_open_reevaluation' },
      });
    }
  }

  /**
   * Marca como bloqueados os contatos da allowlist que ja constam na blocklist
   * da conta. Nunca desbloqueia ninguem automaticamente.
   */
  async syncBlocked(rawJids: readonly string[]): Promise<void> {
    for (const rawJid of rawJids) {
      const jid = normalizeIndividualJid(rawJid);
      if (!jid || !isJidMonitored(jid, this.options.config, this.options.resolveJid)) {
        continue;
      }

      const state = this.options.state.get(jid);
      if (state.blocked) {
        continue;
      }

      this.cancelTimer(jid);
      try {
        const updated = await this.options.state.update(jid, (current) => ({
          ...current,
          blocked: true,
          blockedAt: current.blockedAt ?? iso(this.now()),
          pending: false,
          pendingUntil: null,
        }));
        await this.record({
          jid,
          event: 'blocked_externally',
          detectedValue: state.lastKnownExpiration,
          action: 'mark_blocked',
          counter: updated.offCount,
          details: { reason: 'contact_already_in_account_blocklist' },
        });
      } catch (error) {
        this.options.logger.error(
          { err: describeError(error), jid: maskJid(jid) },
          'Falha ao sincronizar contato bloqueado externamente.',
        );
      }
    }
  }

  /**
   * Encerra os timers sem apagar o estado pendente: a proxima inicializacao
   * retoma a acao.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.timers.values()) {
      timer.cancel();
    }
    this.timers.clear();

    try {
      await this.options.state.save();
    } catch (error) {
      this.options.logger.error(
        { err: describeError(error) },
        'Falha ao salvar o estado durante o encerramento.',
      );
    }
  }

  private async handleDisabled(jid: string, observedAt: number): Promise<void> {
    const previousEventAt = this.lastEventAt.get(jid);
    if (previousEventAt !== undefined && observedAt - previousEventAt < this.dedupeWindowMs) {
      this.options.logger.debug(
        { jid: maskJid(jid) },
        'Evento de desativacao duplicado ignorado.',
      );
      await this.remember(jid, 0);
      return;
    }
    this.lastEventAt.set(jid, observedAt);
    await this.remember(jid, 0);

    let state: ContactState;
    try {
      state = this.options.state.get(jid);
    } catch (error) {
      this.options.logger.error(
        { err: describeError(error), jid: maskJid(jid) },
        'Estado indisponivel ao tratar desativacao.',
      );
      return;
    }

    if (state.blocked) {
      await this.record({
        jid,
        event: 'skipped_blocked',
        detectedValue: 0,
        action: 'none',
        counter: state.offCount,
      });
      return;
    }

    if (state.pending || this.executing.has(jid) || this.timers.has(jid)) {
      await this.record({
        jid,
        event: 'skipped_pending',
        detectedValue: 0,
        action: 'none',
        counter: state.offCount,
      });
      return;
    }

    const now = this.now();
    if (isFuture(state.cooldownUntil, now)) {
      await this.record({
        jid,
        event: 'skipped_cooldown',
        detectedValue: 0,
        action: 'none',
        counter: state.offCount,
        details: { cooldownUntil: state.cooldownUntil },
      });
      return;
    }

    const currentCount = state.offCount;

    // --- REQUISITO 1: PRIMEIRA VEZ (currentCount === 0) ---
    // Reverte instantaneo em silencio
    if (currentCount === 0) {
      try {
        await this.options.actions.setEphemeral(jid, this.options.config.ephemeralSeconds);
      } catch (error) {
        await this.record({
          jid,
          event: 'action_failed',
          detectedValue: 0,
          action: 'reactivate',
          counter: 0,
          details: { stage: 'reactivate_instant', error: describeError(error) },
        });
        return;
      }

      const updated = await this.options.state.update(jid, (current) => ({
        ...current,
        offCount: 1,
        lastOffAt: iso(observedAt),
        lastActionAt: iso(now),
        cooldownUntil: iso(now + this.options.config.cooldownMs),
        pending: false,
        pendingUntil: null,
        lastKnownExpiration: this.options.config.ephemeralSeconds,
      }));

      await this.record({
        jid,
        event: 'reactivated',
        detectedValue: 0,
        action: 'reactivate',
        counter: updated.offCount,
        details: { ephemeralSeconds: this.options.config.ephemeralSeconds, instant: true, reason: 'first_offense' },
      });
      return;
    }

    // --- REQUISITO 2: SEGUNDA VEZ (currentCount === 1) ---
    // Mensagem instantanea da IA; espera 1~3 minutos e volta pra 7 dias
    if (currentCount === 1) {
      try {
        const generated = await this.options.messages.generate('warning');
        await this.options.actions.sendText(jid, generated.text);
        await this.record({
          jid,
          event: 'message_sent',
          detectedValue: 0,
          action: 'send_message',
          counter: 2,
          details: { text: generated.text, source: generated.source, wordCount: countWords(generated.text), stage: 'instant_warning' },
        });
      } catch (error) {
        await this.record({
          jid,
          event: 'message_failed',
          detectedValue: 0,
          action: 'send_message',
          counter: 2,
          details: { error: describeError(error) },
        });
      }

      const delayMs = Math.max(
        0,
        Math.floor(this.randomDelayMs(this.options.config.minDelayMs, this.options.config.maxDelayMs)),
      );
      const pendingUntil = iso(now + delayMs);

      let updated: ContactState;
      try {
        updated = await this.options.state.update(jid, (current) => ({
          ...current,
          pending: true,
          pendingUntil,
          lastOffAt: iso(observedAt),
          lastKnownExpiration: 0,
        }));
      } catch (error) {
        await this.record({
          jid,
          event: 'action_failed',
          detectedValue: 0,
          action: 'schedule',
          counter: 2,
          details: { stage: 'persist_pending', error: describeError(error) },
        });
        return;
      }

      this.schedule(jid, delayMs);
      await this.record({
        jid,
        event: 'detected_disabled',
        detectedValue: 0,
        action: 'scheduled',
        counter: updated.offCount + 1,
        details: { delayMs, pendingUntil, reason: 'second_offense_pending_revert' },
      });
      return;
    }

    // --- REQUISITO 3: TERCEIRA VEZ (currentCount >= 2) ---
    // Mensagem instantanea e bloqueio instantaneo (+ reversao para 7 dias)
    if (currentCount >= 2) {
      const nextCount = currentCount + 1;

      // 1. Mensagem instantanea
      try {
        const farewell = await this.options.messages.generate('farewell');
        await this.options.actions.sendText(jid, farewell.text);
        await this.record({
          jid,
          event: 'message_sent',
          detectedValue: 0,
          action: 'send_message',
          counter: nextCount,
          details: { text: farewell.text, source: farewell.source, wordCount: countWords(farewell.text), stage: 'instant_farewell' },
        });
      } catch (error) {
        await this.record({
          jid,
          event: 'message_failed',
          detectedValue: 0,
          action: 'send_message',
          counter: nextCount,
          details: { error: describeError(error) },
        });
      }

      // 2. Reversao para 7 dias
      try {
        await this.options.actions.setEphemeral(jid, this.options.config.ephemeralSeconds);
        await this.record({
          jid,
          event: 'reactivated',
          detectedValue: 0,
          action: 'reactivate',
          counter: nextCount,
          details: { ephemeralSeconds: this.options.config.ephemeralSeconds, instant: true },
        });
      } catch (error) {
        await this.record({
          jid,
          event: 'action_failed',
          detectedValue: 0,
          action: 'reactivate',
          counter: nextCount,
          details: { stage: 'reactivate_before_block', error: describeError(error) },
        });
      }

      // 3. Bloqueio instantaneo
      try {
        await this.options.actions.block(jid);
        const updated = await this.options.state.update(jid, (current) => ({
          ...current,
          offCount: nextCount,
          blocked: true,
          blockedAt: iso(now),
          lastActionAt: iso(now),
          cooldownUntil: iso(now + this.options.config.cooldownMs),
          pending: false,
          pendingUntil: null,
          lastKnownExpiration: this.options.config.ephemeralSeconds,
        }));
        await this.record({
          jid,
          event: 'contact_blocked',
          detectedValue: 0,
          action: 'block',
          counter: updated.offCount,
        });
      } catch (error) {
        await this.options.state.update(jid, (current) => ({
          ...current,
          offCount: nextCount,
          lastActionAt: iso(now),
          cooldownUntil: iso(now + this.options.config.cooldownMs),
          pending: false,
          pendingUntil: null,
          lastKnownExpiration: this.options.config.ephemeralSeconds,
        }));
        await this.record({
          jid,
          event: 'block_failed',
          detectedValue: 0,
          action: 'block',
          counter: nextCount,
          details: { error: describeError(error) },
        });
      }
      return;
    }
  }

  private async handleEnabled(
    jid: string,
    expiration: number,
    observedAt: number,
  ): Promise<void> {
    try {
      await this.options.state.update(jid, (current) => ({
        ...current,
        lastKnownExpiration: expiration,
      }));
    } catch (error) {
      this.options.logger.error(
        { err: describeError(error), jid: maskJid(jid) },
        'Falha ao registrar reativacao feita pelo contato.',
      );
      return;
    }

    const state = this.options.state.get(jid);
    const timer = this.timers.get(jid);

    if (!state.pending) {
      if (timer) {
        timer.cancel();
        this.timers.delete(jid);
      }
      return;
    }

    if (this.executing.has(jid)) {
      await this.record({
        jid,
        event: 'reenabled_during_action',
        detectedValue: expiration,
        action: 'continue_action',
        counter: state.offCount,
        details: { observedAt: iso(observedAt) },
      });
      return;
    }

    if (timer) {
      timer.cancel();
      this.timers.delete(jid);
    }

    try {
      const updated = await this.options.state.update(jid, (current) => ({
        ...current,
        pending: false,
        pendingUntil: null,
        lastKnownExpiration: expiration,
      }));
      await this.record({
        jid,
        event: 'action_cancelled',
        detectedValue: expiration,
        action: 'cancelled',
        counter: updated.offCount,
        details: { reason: 'contact_reenabled_before_action' },
      });
    } catch (error) {
      this.options.logger.error(
        { err: describeError(error), jid: maskJid(jid) },
        'Falha ao cancelar acao pendente.',
      );
    }
  }

  private async execute(jid: string): Promise<void> {
    if (this.stopped || this.executing.has(jid)) {
      return;
    }

    this.executing.add(jid);
    this.timers.delete(jid);

    try {
      let state = this.options.state.get(jid);

      if (!state.pending) {
        this.options.logger.debug(
          { jid: maskJid(jid) },
          'Acao agendada sem pending; ignorando.',
        );
        return;
      }

      if (state.blocked) {
        const updated = await this.options.state.update(jid, (current) => ({
          ...current,
          pending: false,
          pendingUntil: null,
        }));
        await this.record({
          jid,
          event: 'skipped_blocked',
          detectedValue: 0,
          action: 'clear_pending',
          counter: updated.offCount,
          details: { stage: 'before_action' },
        });
        return;
      }

      if (state.lastKnownExpiration !== 0) {
        const updated = await this.options.state.update(jid, (current) => ({
          ...current,
          pending: false,
          pendingUntil: null,
        }));
        await this.record({
          jid,
          event: 'action_cancelled',
          detectedValue: state.lastKnownExpiration,
          action: 'cancelled',
          counter: updated.offCount,
          details: { reason: 'ephemeral_reenabled_before_action' },
        });
        return;
      }

      try {
        await this.options.actions.setEphemeral(jid, this.options.config.ephemeralSeconds);
      } catch (error) {
        const updated = await this.options.state.update(jid, (current) => ({
          ...current,
          pending: false,
          pendingUntil: null,
        }));
        await this.record({
          jid,
          event: 'action_failed',
          detectedValue: 0,
          action: 'none',
          counter: updated.offCount,
          details: { stage: 'reactivate', error: describeError(error) },
        });
        return;
      }

      const actedAt = this.now();
      state = await this.options.state.update(jid, (current) => ({
        ...current,
        offCount: current.offCount + 1,
        lastActionAt: iso(actedAt),
        cooldownUntil: iso(actedAt + this.options.config.cooldownMs),
        pending: false,
        pendingUntil: null,
        lastKnownExpiration: this.options.config.ephemeralSeconds,
      }));

      await this.record({
        jid,
        event: 'reactivated',
        detectedValue: 0,
        action: 'reactivate',
        counter: state.offCount,
        details: { ephemeralSeconds: this.options.config.ephemeralSeconds, reason: 'second_offense_timer_completed' },
      });
    } catch (error) {
      this.options.logger.error(
        { err: describeError(error), jid: maskJid(jid) },
        'Falha inesperada ao executar acao pendente.',
      );

      try {
        const updated = await this.options.state.update(jid, (current) => ({
          ...current,
          pending: false,
          pendingUntil: null,
        }));
        await this.record({
          jid,
          event: 'action_failed',
          detectedValue: null,
          action: 'none',
          counter: updated.offCount,
          details: { stage: 'unexpected', error: describeError(error) },
        });
      } catch (nestedError) {
        this.options.logger.error(
          { err: describeError(nestedError), jid: maskJid(jid) },
          'Falha ao limpar pending apos erro inesperado.',
        );
      }
    } finally {
      this.executing.delete(jid);
    }
  }

  private schedule(jid: string, delayMs: number): void {
    if (this.stopped) {
      return;
    }

    this.cancelTimer(jid);
    const timer = this.scheduler.schedule(() => {
      void this.execute(jid);
    }, Math.max(0, Math.floor(delayMs)));
    this.timers.set(jid, timer);
  }

  private cancelTimer(jid: string): void {
    const timer = this.timers.get(jid);
    if (timer) {
      timer.cancel();
      this.timers.delete(jid);
    }
  }

  private async remember(jid: string, expiration: number): Promise<void> {
    if (this.options.state.has(jid) && this.options.state.get(jid).lastKnownExpiration === expiration) {
      return;
    }

    try {
      await this.options.state.update(jid, (current) => ({
        ...current,
        lastKnownExpiration: expiration,
      }));
    } catch (error) {
      this.options.logger.error(
        { err: describeError(error), jid: maskJid(jid) },
        'Falha ao persistir o ultimo valor de mensagens temporarias.',
      );
    }
  }

  private async cancelPending(
    jid: string,
    reason: string,
    counter: number,
  ): Promise<void> {
    try {
      await this.options.state.update(jid, (current) => ({
        ...current,
        pending: false,
        pendingUntil: null,
      }));
      await this.record({
        jid,
        event: 'action_cancelled',
        detectedValue: null,
        action: 'cancelled',
        counter,
        details: { reason },
      });
    } catch (error) {
      this.options.logger.error(
        { err: describeError(error), jid: maskJid(jid) },
        'Falha ao cancelar pending durante a inicializacao.',
      );
    }
  }

  private async record(input: AuditInput): Promise<void> {
    try {
      await this.options.audit.append(input);
    } catch (error) {
      this.options.logger.error(
        { err: describeError(error) },
        'Falha ao registrar evento de auditoria.',
      );
    }

    if (this.options.notifier) {
      try {
        await this.options.notifier.notifyAuditEvent(input);
      } catch (error) {
        this.options.logger.error(
          { err: describeError(error) },
          'Falha ao enviar notificacao via Telegram.',
        );
      }
    }
  }
}
