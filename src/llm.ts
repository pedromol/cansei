import { randomInt } from 'node:crypto';
import OpenAI from 'openai';
import type { Logger } from 'pino';

export const MAX_MESSAGE_WORDS = 25;

export const SYSTEM_PROMPT_WARNING = [
  'Escreva uma única frase curta em português brasileiro.',
  'Identifique-se claramente como a inteligência artificial responsável por gerenciar este WhatsApp.',
  'Contexto: o contato desativou as mensagens temporárias pela segunda vez.',
  'Objetivo: avisar que mensagens temporárias são obrigatórias nesta conta e que serão reativadas em instantes.',
  'Regras: máximo 22 palavras; tom educado, direto e firme; termine com ponto final.',
].join(' ');

export const SYSTEM_PROMPT_FAREWELL = [
  'Escreva uma única frase curta em português brasileiro.',
  'Identifique-se claramente como a inteligência artificial responsável por gerenciar este WhatsApp.',
  'Contexto: o contato desativou as mensagens temporárias pela terceira vez consecutiva.',
  'Objetivo: avisar que devido à nova desativação o contato está sendo bloqueado pelo sistema.',
  'Regras: máximo 22 palavras; tom neutro, formal e definitivo; termine com ponto final.',
].join(' ');

export const SYSTEM_PROMPT = SYSTEM_PROMPT_WARNING;

export const FALLBACK_WARNING_MESSAGES: readonly string[] = [
  'Olá! Sou o assistente de IA deste WhatsApp: mensagens temporárias são obrigatórias por aqui e serão reativadas em instantes.',
  'Aviso automático da IA: mensagens temporárias são padrão nesta conversa e serão reabilitadas em instantes.',
  'Olá! Sou a inteligência artificial gerenciando esta conta. Mensagens temporárias são exigidas e voltarão em breve.',
];

export const FALLBACK_FAREWELL_MESSAGES: readonly string[] = [
  'Aviso da IA: devido a desativações repetidas das mensagens temporárias, este contato foi bloqueado pelo sistema.',
  'Olá! Sou o assistente de IA desta conta. Como as mensagens temporárias foram desativadas novamente, o contato foi bloqueado.',
  'Mensagem automática da IA: regras de mensagens temporárias foram descumpridas repetidamente e o contato foi bloqueado.',
];

export const FALLBACK_MESSAGES: readonly string[] = FALLBACK_WARNING_MESSAGES;

const FORBIDDEN_CONTENT =
  /bloquear|denunciar|amea[cç]a|xing|sarcas|https?:\/\/|api[ _-]?key|credits?|quota|pollinations|balance/i;

const FORBIDDEN_ACCUSATION = /voc[eê]\s+(?:desativ|remove|tir)/i;

export interface CompletionRequest {
  model: string;
  systemPrompt: string;
  userPrompt: string;
}

export type CompletionFactory = (request: CompletionRequest) => Promise<string>;

export interface GeneratedMessage {
  text: string;
  source: 'llm' | 'fallback';
}

export interface MessageGeneratorOptions {
  model: string;
  logger: Logger;
  apiKey?: string;
  complete?: CompletionFactory;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  temperature?: number;
  maxTokens?: number;
  pick?: <T>(items: readonly T[]) => T;
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Normaliza e valida a resposta do LLM. Retorna null quando a frase foge das
 * regras de seguranca, tamanho ou formato.
 */
export function sanitizeMessage(raw: string): string | null {
  if (typeof raw !== 'string') {
    return null;
  }

  const firstLine = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

  if (!firstLine) {
    return null;
  }

  let text = firstLine
    .replace(/^[\s"'`“”‘’]+/, '')
    .replace(/[\s"'`“”‘’]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();

  const firstSentence = /^[^.!?]+[.!?]/.exec(text)?.[0];
  if (firstSentence) {
    text = firstSentence.trim();
  }

  if (!text || countWords(text) > MAX_MESSAGE_WORDS) {
    return null;
  }

  if (FORBIDDEN_CONTENT.test(text) || FORBIDDEN_ACCUSATION.test(text)) {
    return null;
  }

  return text;
}

export function pickFallbackMessage(
  kind: 'warning' | 'farewell' = 'warning',
  pick: <T>(items: readonly T[]) => T = (items) => items[randomInt(items.length)]!,
): string {
  const pool = kind === 'farewell' ? FALLBACK_FAREWELL_MESSAGES : FALLBACK_WARNING_MESSAGES;
  return pick(pool);
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export class MessageGenerator {
  private readonly complete?: CompletionFactory;
  private readonly pick: <T>(items: readonly T[]) => T;

  constructor(private readonly options: MessageGeneratorOptions) {
    this.complete =
      options.complete ??
      (options.apiKey ? this.createOpenAiCompleter(options.apiKey) : undefined);
    this.pick = options.pick ?? ((items) => items[randomInt(items.length)]!);
  }

  private createOpenAiCompleter(apiKey: string): CompletionFactory {
    const client = new OpenAI({
      apiKey,
      ...(this.options.baseUrl ? { baseURL: this.options.baseUrl } : {}),
      timeout: this.options.timeoutMs ?? 8_000,
      maxRetries: this.options.maxRetries ?? 0,
    });

    return async ({ model, systemPrompt, userPrompt }) => {
      const completion = await client.chat.completions.create({
        model,
        temperature: this.options.temperature ?? 1.05,
        max_tokens: this.options.maxTokens ?? 60,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      });

      return completion.choices[0]?.message?.content ?? '';
    };
  }

  async generate(kind: 'warning' | 'farewell' = 'warning'): Promise<GeneratedMessage> {
    if (!this.complete) {
      return { text: pickFallbackMessage(kind, this.pick), source: 'fallback' };
    }

    const systemPrompt = kind === 'farewell' ? SYSTEM_PROMPT_FAREWELL : SYSTEM_PROMPT_WARNING;

    try {
      const raw = await this.complete({
        model: this.options.model,
        systemPrompt,
        userPrompt: 'Gere a frase agora.',
      });
      const text = sanitizeMessage(raw);
      if (text) {
        return { text, source: 'llm' };
      }
      this.options.logger.warn(
        'A resposta do LLM foi descartada por violar as regras; usando mensagem fallback.',
      );
    } catch (error) {
      this.options.logger.warn(
        { err: describeError(error) },
        'Falha ao chamar o LLM; usando mensagem fallback.',
      );
    }

    return { text: pickFallbackMessage(kind, this.pick), source: 'fallback' };
  }
}
