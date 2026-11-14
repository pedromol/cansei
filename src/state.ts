import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Logger } from 'pino';

export const STATE_VERSION = 1;

export interface ContactState {
  jid: string;
  offCount: number;
  lastOffAt: string | null;
  lastActionAt: string | null;
  cooldownUntil: string | null;
  blocked: boolean;
  blockedAt: string | null;
  pending: boolean;
  /** Instante em que a acao pendente deve ser executada. */
  pendingUntil: string | null;
  /** Ultimo valor de ephemeralExpiration observado para o contato. */
  lastKnownExpiration: number | null;
}

export interface PersistedState {
  version: typeof STATE_VERSION;
  updatedAt: string;
  contacts: Record<string, ContactState>;
}

export interface AuditEntry {
  timestamp: string;
  jid: string;
  event: string;
  detectedValue: number | null;
  action: string;
  counter: number;
  details?: Record<string, unknown>;
}

export type AuditInput = Omit<AuditEntry, 'timestamp'>;

export class StateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StateError';
  }
}

export function createContactState(jid: string): ContactState {
  return {
    jid,
    offCount: 0,
    lastOffAt: null,
    lastActionAt: null,
    cooldownUntil: null,
    blocked: false,
    blockedAt: null,
    pending: false,
    pendingUntil: null,
    lastKnownExpiration: null,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readIsoOrNull(value: unknown, field: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new StateError(`Estado invalido: ${field} deve ser uma data ISO ou null.`);
  }
  return value;
}

function readBoolean(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'boolean') {
    throw new StateError(`Estado invalido: ${field} deve ser booleano.`);
  }
  return value;
}

function readCount(value: unknown, field: string): number {
  if (value === undefined) {
    return 0;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new StateError(`Estado invalido: ${field} deve ser um inteiro nao negativo.`);
  }
  return value;
}

function readExpiration(value: unknown): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new StateError(
      'Estado invalido: lastKnownExpiration deve ser um numero nao negativo ou null.',
    );
  }
  return value;
}

function parseContact(jid: string, value: unknown): ContactState {
  const record = asRecord(value);
  if (!record) {
    throw new StateError(`Estado invalido para o contato "${jid}".`);
  }

  if (record.jid !== undefined && record.jid !== jid) {
    throw new StateError(`Estado invalido: a chave "${jid}" nao corresponde ao campo jid.`);
  }

  return {
    jid,
    offCount: readCount(record.offCount, `${jid}.offCount`),
    lastOffAt: readIsoOrNull(record.lastOffAt, `${jid}.lastOffAt`),
    lastActionAt: readIsoOrNull(record.lastActionAt, `${jid}.lastActionAt`),
    cooldownUntil: readIsoOrNull(record.cooldownUntil, `${jid}.cooldownUntil`),
    blocked: readBoolean(record.blocked, `${jid}.blocked`, false),
    blockedAt: readIsoOrNull(record.blockedAt, `${jid}.blockedAt`),
    pending: readBoolean(record.pending, `${jid}.pending`, false),
    pendingUntil: readIsoOrNull(record.pendingUntil, `${jid}.pendingUntil`),
    lastKnownExpiration: readExpiration(record.lastKnownExpiration),
  };
}

export function parsePersistedState(raw: unknown): PersistedState {
  const record = asRecord(raw);
  if (!record) {
    throw new StateError('Estado invalido: o arquivo nao contem um objeto JSON.');
  }
  if (record.version !== STATE_VERSION) {
    throw new StateError(
      `Versao de estado nao suportada: ${String(record.version)}. Esperada: ${STATE_VERSION}.`,
    );
  }

  const contactsRecord = asRecord(record.contacts);
  if (!contactsRecord) {
    throw new StateError('Estado invalido: "contacts" deve ser um objeto.');
  }

  const contacts: Record<string, ContactState> = {};
  for (const [jid, value] of Object.entries(contactsRecord)) {
    contacts[jid] = parseContact(jid, value);
  }

  return {
    version: STATE_VERSION,
    updatedAt: readIsoOrNull(record.updatedAt, 'updatedAt') ?? new Date().toISOString(),
    contacts,
  };
}

export function emptyState(now = new Date()): PersistedState {
  return {
    version: STATE_VERSION,
    updatedAt: now.toISOString(),
    contacts: {},
  };
}

/**
 * Estado em memoria com persistencia atomica em disco.
 *
 * As mutacoes sao serializadas em uma fila interna para evitar gravacoes
 * concorrentes do mesmo arquivo.
 */
export class StateStore {
  private state: PersistedState = emptyState();
  private loaded = false;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    readonly filePath: string,
    private readonly logger?: Logger,
  ) {
    mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  }

  async load(): Promise<void> {
    try {
      const content = await readFile(this.filePath, 'utf8');
      this.state = parsePersistedState(JSON.parse(content) as unknown);
    } catch (error) {
      const code = asRecord(error)?.code;
      if (code === 'ENOENT') {
        this.state = emptyState();
        await this.persistAtomic();
      } else if (error instanceof SyntaxError || error instanceof StateError) {
        const backup = `${this.filePath}.corrupt-${Date.now()}`;
        try {
          await rename(this.filePath, backup);
        } catch {
          // Se nem o backup funcionar, o erro original ainda e mais util.
        }
        throw new StateError(
          `Nao foi possivel ler ${this.filePath}. O arquivo foi preservado como ${backup}. Corrija ou remova o estado antes de reiniciar. Detalhe: ${error.message}`,
        );
      } else {
        throw error;
      }
    }

    this.loaded = true;
  }

  private assertLoaded(): void {
    if (!this.loaded) {
      throw new StateError('StateStore.load() deve ser chamado antes de acessar o estado.');
    }
  }

  get(jid: string): ContactState {
    this.assertLoaded();
    const contact = this.state.contacts[jid];
    return contact ? structuredClone(contact) : createContactState(jid);
  }

  all(): ContactState[] {
    this.assertLoaded();
    return Object.values(this.state.contacts).map((contact) => structuredClone(contact));
  }

  has(jid: string): boolean {
    this.assertLoaded();
    return Object.prototype.hasOwnProperty.call(this.state.contacts, jid);
  }

  update(jid: string, updater: (current: ContactState) => ContactState): Promise<ContactState> {
    this.assertLoaded();
    return this.enqueue(async () => {
      const current = this.state.contacts[jid] ?? createContactState(jid);
      const next = updater(structuredClone(current));
      next.jid = jid;
      this.state.contacts[jid] = next;
      this.state.updatedAt = new Date().toISOString();
      await this.persistAtomic();
      return structuredClone(next);
    });
  }

  save(): Promise<void> {
    this.assertLoaded();
    return this.enqueue(async () => {
      this.state.updatedAt = new Date().toISOString();
      await this.persistAtomic();
    });
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task, task);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async persistAtomic(): Promise<void> {
    const directory = path.dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    const payload = `${JSON.stringify(this.state, null, 2)}\n`;
    await writeFile(temporary, payload, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.filePath);
  }
}

/**
 * Log de auditoria JSONL. Cada linha e um evento independente, gravado em
 * ordem e sem o conteudo das mensagens trocadas.
 */
export class AuditLogger {
  private tail: Promise<void> = Promise.resolve();

  constructor(
    readonly filePath: string,
    private readonly logger?: Logger,
  ) {
    mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  }

  append(input: AuditInput): Promise<void> {
    const entry: AuditEntry = {
      timestamp: new Date().toISOString(),
      jid: input.jid,
      event: input.event,
      detectedValue: input.detectedValue,
      action: input.action,
      counter: input.counter,
      ...(input.details ? { details: input.details } : {}),
    };

    const line = `${JSON.stringify(entry)}\n`;
    const run = this.tail.then(
      () => appendFile(this.filePath, line, { encoding: 'utf8', mode: 0o600 }),
      () => appendFile(this.filePath, line, { encoding: 'utf8', mode: 0o600 }),
    );
    this.tail = run.then(
      () => undefined,
      (error: unknown) => {
        this.logger?.error({ err: error }, 'Falha ao gravar o log de auditoria');
      },
    );
    return this.tail;
  }

  async flush(): Promise<void> {
    await this.tail;
  }
}
