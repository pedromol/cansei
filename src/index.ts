import { randomInt } from 'node:crypto';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
  isJidStatusBroadcast,
  normalizeMessageContent,
  proto,
  useMultiFileAuthState,
  type Chat,
  type ConnectionState,
  type WASocket,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcodeTerminal from 'qrcode-terminal';
import { ConfigError, ensureRuntimeDirs, loadConfig, type AppConfig } from './config.js';
import { EphemeralGuard, type GuardActions } from './guard.js';
import { MessageGenerator } from './llm.js';
import { TelegramNotifier } from './notifier.js';
import { AuditLogger, StateStore } from './state.js';

function loadStartupConfig(): AppConfig {
  try {
    const loaded = loadConfig();
    ensureRuntimeDirs(loaded);
    return loaded;
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`[cansei] Configuracao invalida: ${error.message}`);
      process.exit(1);
    }
    console.error(`[cansei] Falha ao preparar a aplicacao: ${describeError(error)}`);
    process.exit(1);
  }
}

const config = loadStartupConfig();

const logger = pino({
  level: config.logLevel,
  base: { app: 'cansei' },
});

const baileysLogger = pino({
  level: config.logLevel === 'trace' || config.logLevel === 'debug' ? config.logLevel : 'warn',
  base: { module: 'baileys' },
});

const state = new StateStore(config.statePath, logger);
const audit = new AuditLogger(config.auditPath, logger);
const notifier = new TelegramNotifier({
  botToken: config.telegramBotToken,
  chatId: config.telegramChatId,
  logger,
  resolveJid: (jid) => lidToPn.get(jid) ?? pnToLid.get(jid),
});
const messages = new MessageGenerator({
  model: config.openaiModel,
  baseUrl: config.openaiBaseUrl,
  timeoutMs: config.openaiTimeoutMs,
  maxRetries: config.openaiMaxRetries,
  temperature: config.openaiTemperature,
  maxTokens: config.openaiMaxTokens,
  logger,
  ...(config.openaiApiKey ? { apiKey: config.openaiApiKey } : {}),
});

let socket: WASocket | null = null;
let connected = false;
let connecting = false;
let shuttingDown = false;
let reconnectTimer: NodeJS.Timeout | null = null;
let reconnectAttempts = 0;

interface OpenWaiter {
  resolve: (sock: WASocket) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const openWaiters = new Set<OpenWaiter>();

function flushOpenWaiters(): void {
  if (!socket || !connected) {
    return;
  }

  const current = socket;
  for (const waiter of [...openWaiters]) {
    clearTimeout(waiter.timer);
    openWaiters.delete(waiter);
    waiter.resolve(current);
  }
}

function rejectOpenWaiters(error: Error): void {
  for (const waiter of [...openWaiters]) {
    clearTimeout(waiter.timer);
    openWaiters.delete(waiter);
    waiter.reject(error);
  }
}

/**
 * Acões externas esperam a conexão ficar disponível, em vez de falhar
 * imediatamente durante uma reconexão transitória.
 */
function waitForSocket(timeoutMs = 120_000): Promise<WASocket> {
  if (socket && connected) {
    return Promise.resolve(socket);
  }

  return new Promise<WASocket>((resolve, reject) => {
    const waiter: OpenWaiter = {
      resolve,
      reject,
      timer: setTimeout(() => {
        openWaiters.delete(waiter);
        reject(new Error('WhatsApp nao reconectou dentro do tempo limite.'));
      }, timeoutMs),
    };
    openWaiters.add(waiter);
  });
}

const lidToPn = new Map<string, string>();
const pnToLid = new Map<string, string>();

const actions: GuardActions = {
  async setEphemeral(jid, seconds) {
    const sock = await waitForSocket();
    const isLid = jid.endsWith('@lid');
    const pn = isLid ? lidToPn.get(jid) : jid;

    // Dispara a configuracao de mensagens efemeras para o JID do evento
    await sock.sendMessage(jid, { disappearingMessagesInChat: seconds });

    // Se houver numero de telefone mapeado para o LID, envia tambem para o PN JID
    if (pn && pn !== jid) {
      await sock.sendMessage(pn, { disappearingMessagesInChat: seconds });
      logger.info({ jid, pn, seconds }, 'Mensagens efemeras enviadas tambem para o PN JID.');
    }
  },
  async sendText(jid, text) {
    const sock = await waitForSocket();
    await sock.sendMessage(jid, { text });
  },
  async block(jid) {
    const sock = await waitForSocket();
    const isLid = jid.endsWith('@lid');
    const pn = isLid ? lidToPn.get(jid) : jid;
    const lid = isLid ? jid : pnToLid.get(jid) ?? jid;

    const itemAttrs: Record<string, string> = { action: 'block', jid: lid };
    if (pn) {
      itemAttrs.pn_jid = pn.includes('@') ? pn : `${pn}@s.whatsapp.net`;
    }

    try {
      await (sock as unknown as { query: (node: unknown) => Promise<unknown> }).query({
        tag: 'iq',
        attrs: {
          xmlns: 'blocklist',
          to: 's.whatsapp.net',
          type: 'set',
        },
        content: [
          {
            tag: 'item',
            attrs: itemAttrs,
          },
        ],
      });
      logger.info({ jid, itemAttrs }, 'Bloqueio aplicado com sucesso via IQ blocklist.');
    } catch (err) {
      logger.warn(
        { jid, itemAttrs, err: describeError(err) },
        'Falha no IQ blocklist; tentando fallback sock.updateBlockStatus.',
      );
      await sock.updateBlockStatus(pn ?? jid, 'block');
    }
  },
};

const guard = new EphemeralGuard({
  config,
  state,
  audit,
  messages,
  actions,
  notifier,
  logger,
  resolveJid: (jid) => lidToPn.get(jid) ?? pnToLid.get(jid),
});

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function findContextExpiration(message: proto.IMessage | null | undefined): number | undefined {
  if (!message) {
    return undefined;
  }
  for (const key of Object.keys(message)) {
    const field = (message as Record<string, unknown>)[key];
    if (field && typeof field === 'object' && field !== null) {
      const contextInfo = (field as { contextInfo?: { expiration?: number } }).contextInfo;
      if (typeof contextInfo?.expiration === 'number' && contextInfo.expiration > 0) {
        return contextInfo.expiration;
      }
    }
  }
  return undefined;
}

function extractMessageExpiration(msg: proto.IWebMessageInfo): number | undefined {
  const message = msg.message;
  if (!message) {
    return undefined;
  }

  // 1. Mensagem empacotada explicitamente como ephemeralMessage
  if (message.ephemeralMessage) {
    const inner = message.ephemeralMessage.message;
    const innerExp = findContextExpiration(inner);
    return innerExp !== undefined && innerExp > 0 ? innerExp : 604800;
  }

  // 2. Procura expiration no contextInfo de submensagens
  const exp = findContextExpiration(message);
  if (exp !== undefined && exp > 0) {
    return exp;
  }

  // 3. Mensagem normal sem ephemeralMessage nem contextInfo.expiration => chat com efemero desativado!
  return 0;
}

function readExpiration(value: unknown): number | undefined {
  if (value === null || value === 0) {
    return 0;
  }
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value;
  }
  return undefined;
}

function readChatId(value: unknown): string | null {
  const record = asRecord(value);
  const id = record?.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function observeSafely(
  jid: string,
  expiration: number | null,
  source: 'update' | 'history' | 'upsert',
): void {
  void guard.observe(jid, expiration, source).catch((error: unknown) => {
    logger.error({ err: describeError(error), jid }, 'Falha ao processar evento de chat.');
  });
}

function observeChat(value: unknown, source: 'history' | 'upsert'): void {
  const record = asRecord(value);
  if (!record) {
    return;
  }

  const jid = readChatId(record);
  const expiration = readExpiration(record.ephemeralExpiration);
  if (!jid || expiration === undefined) {
    return;
  }

  observeSafely(jid, expiration, source);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getStatusCode(error: unknown): number | undefined {
  const output = asRecord(asRecord(error)?.output);
  const statusCode = output?.statusCode;
  return typeof statusCode === 'number' ? statusCode : undefined;
}

function shouldIgnoreChatJid(jid: string | null | undefined): boolean {
  if (!jid) {
    return true;
  }
  return Boolean(
    isJidNewsletter(jid) ||
      isJidBroadcast(jid) ||
      isJidGroup(jid) ||
      isJidStatusBroadcast(jid),
  );
}

/**
 * A API de eventos do Baileys e nao oficial: os payloads sao lidos de forma
 * defensiva e campos ausentes/invalidos sao ignorados.
 */
function bindSocketEvents(sock: WASocket): void {
  sock.ev.on('creds.update', () => {
    void saveCredsSafely();
  });

  sock.ev.on('connection.update', (update: Partial<ConnectionState>) => {
    void handleConnectionUpdate(sock, update);
  });

  sock.ev.on('chats.update', (updates) => {
    for (const update of updates) {
      const jid = readChatId(update);
      if (!jid || shouldIgnoreChatJid(jid)) {
        continue;
      }
      const pnJid = asRecord(update)?.pnJid;
      if (typeof pnJid === 'string' && pnJid.length > 0) {
        lidToPn.set(jid, pnJid);
      }
      const rawExp = asRecord(update)?.ephemeralExpiration;
      const expiration = readExpiration(rawExp);
      if (expiration === undefined) {
        continue;
      }
      logger.info({ jid, expiration, rawExp }, 'Evento de chat recebido via chats.update.');
      observeSafely(jid, expiration, 'update');
    }
  });

  sock.ev.on('messages.upsert', ({ messages: upsertedMessages }) => {
    for (const msg of upsertedMessages) {
      const rawJid = msg.key?.remoteJid;
      if (!rawJid || shouldIgnoreChatJid(rawJid)) {
        continue;
      }

      const keyRecord = msg.key as Record<string, unknown> | undefined;
      const rawPn =
        keyRecord?.senderPn ??
        keyRecord?.participantPn ??
        keyRecord?.remoteJidAlt ??
        (msg as unknown as Record<string, unknown>).senderPn;

      if (typeof rawPn === 'string' && rawPn.length > 0) {
        const fullPn = rawPn.includes('@') ? rawPn : `${rawPn}@s.whatsapp.net`;
        lidToPn.set(rawJid, fullPn);
        pnToLid.set(fullPn, rawJid);
      }

      const content = normalizeMessageContent(msg.message);
      const protocolMsg = content?.protocolMessage;
      if (
        protocolMsg &&
        (protocolMsg.type === proto.Message.ProtocolMessage.Type.EPHEMERAL_SETTING ||
          protocolMsg.type === proto.Message.ProtocolMessage.Type.EPHEMERAL_SYNC_RESPONSE ||
          protocolMsg.ephemeralExpiration !== undefined)
      ) {
        const expiration = readExpiration(protocolMsg.ephemeralExpiration) ?? 0;
        logger.info(
          {
            jid: rawJid,
            expiration,
            rawExpiration: protocolMsg.ephemeralExpiration,
            fromMe: msg.key?.fromMe,
          },
          'Evento de mensagens efemeras recebido via messages.upsert.',
        );
        observeSafely(rawJid, expiration, 'update');
      } else if (!protocolMsg && !msg.key?.fromMe && msg.message) {
        const msgExp = extractMessageExpiration(msg);
        if (msgExp !== undefined) {
          void guard.ensureEnabledOnMessage(rawJid, msgExp).catch((error: unknown) => {
            logger.error(
              { err: describeError(error), jid: rawJid },
              'Falha ao verificar/ativar efemero em mensagem normal.',
            );
          });
        }
      }
    }
  });

  sock.ev.on('chats.upsert', (chats: Chat[]) => {
    for (const chat of chats) {
      const id = readChatId(chat);
      if (!id || shouldIgnoreChatJid(id)) {
        continue;
      }
      const pn = asRecord(chat)?.pnJid;
      if (typeof pn === 'string' && pn.length > 0) {
        lidToPn.set(id, pn);
        pnToLid.set(pn, id);
      }
      observeChat(chat, 'upsert');
    }
  });

  sock.ev.on('messaging-history.set', (event) => {
    const chats = asRecord(event)?.chats;
    if (!Array.isArray(chats)) {
      return;
    }
    for (const chat of chats) {
      const id = readChatId(chat);
      if (!id || shouldIgnoreChatJid(id)) {
        continue;
      }
      const pn = asRecord(chat)?.pnJid;
      if (typeof pn === 'string' && pn.length > 0) {
        lidToPn.set(id, pn);
        pnToLid.set(pn, id);
      }
      observeChat(chat, 'history');
    }
  });

  sock.ev.on('contacts.upsert' as never, ((contacts: unknown[]) => {
    for (const c of contacts) {
      const rec = asRecord(c);
      const id = typeof rec?.id === 'string' ? rec.id : null;
      const lid = typeof rec?.lid === 'string' ? rec.lid : null;
      if (id && lid) {
        lidToPn.set(lid, id);
        pnToLid.set(id, lid);
        logger.debug({ id, lid }, 'Mapeamento Contato -> LID registrado via contacts.upsert.');
      }
    }
  }) as never);

  sock.ev.on('contacts.update' as never, ((updates: unknown[]) => {
    for (const u of updates) {
      const rec = asRecord(u);
      const id = typeof rec?.id === 'string' ? rec.id : null;
      const lid = typeof rec?.lid === 'string' ? rec.lid : null;
      if (id && lid) {
        lidToPn.set(lid, id);
        pnToLid.set(id, lid);
        logger.debug({ id, lid }, 'Mapeamento Contato -> LID registrado via contacts.update.');
      }
    }
  }) as never);
}

let saveCreds: (() => Promise<void>) | null = null;

async function saveCredsSafely(): Promise<void> {
  if (!saveCreds) {
    return;
  }
  try {
    await saveCreds();
  } catch (error) {
    logger.error({ err: describeError(error) }, 'Falha ao salvar credenciais do WhatsApp.');
  }
}

async function connect(): Promise<void> {
  if (shuttingDown || connecting) {
    return;
  }

  connecting = true;
  try {
    const { state: authState, saveCreds: persistCreds } = await useMultiFileAuthState(
      config.authDir,
    );
    saveCreds = persistCreds;

    const sock = makeWASocket({
      auth: authState,
      browser: Browsers.ubuntu('Chrome'),
      logger: baileysLogger,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      fireInitQueries: false,
      shouldIgnoreJid: (jid) => shouldIgnoreChatJid(jid),
    });

    socket = sock;
    bindSocketEvents(sock);
    logger.info('Conexao com o WhatsApp iniciada.');
  } catch (error) {
    logger.error({ err: describeError(error) }, 'Falha ao iniciar a conexao com o WhatsApp.');
    scheduleReconnect();
  } finally {
    connecting = false;
  }
}

async function handleConnectionUpdate(
  sock: WASocket,
  update: Partial<ConnectionState>,
): Promise<void> {
  if (shuttingDown) {
    return;
  }

  if (update.qr) {
    logger.info('Escaneie o QR Code abaixo com o WhatsApp da conta monitorada.');
    qrcodeTerminal.generate(update.qr, { small: true });
  }

  if (update.connection === 'open') {
    if (connected) {
      return;
    }
    connected = true;
    reconnectAttempts = 0;
    logger.info('Conectado ao WhatsApp.');
    flushOpenWaiters();

    void guard.onConnectionOpen().catch((error: unknown) => {
      logger.error(
        { err: describeError(error) },
        'Falha ao remarcar acoes pendentes apos conexao.',
      );
    });
    void syncBlocklist(sock);
    return;
  }

  if (update.connection === 'close') {
    connected = false;
    const statusCode = getStatusCode(update.lastDisconnect?.error);

    if (statusCode === DisconnectReason.loggedOut) {
      logger.error(
        'Sessao encerrada pelo WhatsApp (loggedOut). Remova a pasta auth/ e escaneie um novo QR Code.',
      );
      await shutdown(1);
      return;
    }

    logger.warn(
      { statusCode },
      'Conexao encerrada. A reconexao sera tentada automaticamente.',
    );
    scheduleReconnect();
  }
}

async function syncBlocklist(sock: WASocket): Promise<void> {
  try {
    const blocklist = await sock.fetchBlocklist();
    const jids = blocklist.filter(
      (jid): jid is string => typeof jid === 'string' && jid.length > 0,
    );
    await guard.syncBlocked(jids);
    logger.debug({ blockedCount: jids.length }, 'Blocklist da conta sincronizada.');
  } catch (error) {
    logger.warn(
      { err: describeError(error) },
      'Nao foi possivel sincronizar a blocklist da conta; seguindo com o estado local.',
    );
  }
}

function scheduleReconnect(): void {
  if (shuttingDown || reconnectTimer) {
    return;
  }

  const attempt = reconnectAttempts;
  reconnectAttempts += 1;
  const baseDelay = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
  const jitter = randomInt(0, Math.max(1, Math.floor(baseDelay * 0.2)));
  const delayMs = baseDelay + jitter;

  logger.warn({ delayMs, attempt: attempt + 1 }, 'Agendando reconexao.');
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, delayMs);
}

let shutdownPromise: Promise<void> | null = null;

async function shutdown(exitCode: number): Promise<void> {
  if (shutdownPromise) {
    await shutdownPromise;
    return;
  }

  shuttingDown = true;
  shutdownPromise = (async () => {
    logger.info({ exitCode }, 'Encerrando o cansei.');

    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    rejectOpenWaiters(new Error('Processo encerrando.'));

    try {
      await guard.stop();
    } catch (error) {
      logger.error({ err: describeError(error) }, 'Falha ao encerrar o guard.');
    }

    try {
      await state.save();
    } catch (error) {
      logger.error({ err: describeError(error) }, 'Falha ao salvar o estado final.');
    }

    try {
      await audit.flush();
    } catch (error) {
      logger.error({ err: describeError(error) }, 'Falha ao finalizar o log de auditoria.');
    }

    try {
      socket?.end(undefined);
    } catch (error) {
      logger.error({ err: describeError(error) }, 'Falha ao encerrar o socket.');
    }

    process.exit(exitCode);
  })();

  await shutdownPromise;
}

async function main(): Promise<void> {
  await state.load();

  logger.info(
    {
      allowAll: config.allowAll,
      allowedContacts: config.allowAll ? 'all' : config.allowedJids.size,
      excludedContacts: config.excludedJids.size,
      ephemeralSeconds: config.ephemeralSeconds,
      cooldownHours: config.cooldownMs / 3_600_000,
      minDelayMinutes: config.minDelayMs / 60_000,
      maxDelayMinutes: config.maxDelayMs / 60_000,
      openaiConfigured: Boolean(config.openaiApiKey),
      telegramConfigured: notifier.enabled,
    },
    'Configuracao carregada.',
  );

  await guard.init();

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void shutdown(0);
    });
  }

  process.on('unhandledRejection', (reason) => {
    logger.error({ err: describeError(reason) }, 'Promise rejeitada sem tratamento.');
  });

  await connect();
}

void main().catch((error: unknown) => {
  logger.error({ err: describeError(error) }, 'Falha fatal na inicializacao.');
  process.exitCode = 1;
});
