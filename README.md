# cansei

Monitor de conversas **individuais** do WhatsApp que reage quando o outro participante desativa as mensagens temporárias ou quando uma conversa existente é detectada sem o recurso ativado.

> **Aviso importante:** este projeto usa o [Baileys](https://github.com/Whiskeysockets/Baileys), que implementa o protocolo **não oficial** do WhatsApp Web. O uso de APIs não oficiais viola os Termos de Serviço do WhatsApp e pode resultar em **restrição, suspensão ou banimento permanente da conta**. Use por sua conta e risco, preferencialmente em um número secundário.

---

## Como funciona

O monitor vigia conversas individuais do WhatsApp com base em `ALLOWED_JIDS` e `EXCLUDED_JIDS`. Ele observa alterações nas mensagens temporárias (`chats.update`) e a chegada de novas mensagens (`messages.upsert`).

### Penalidades progressivas em 3 níveis

| Desativação detectada | Ação imediata | Delay configurável | Ação após delay |
| --- | --- | --- | --- |
| **1ª vez** | Reativa para 7 dias em silêncio | Nenhum | - |
| **2ª vez** | Envia frase de aviso via IA (ou fallback) | Aguarda (ex.: 1 a 3 min) | Reativa para 7 dias |
| **3ª vez ou posterior** | Envia frase de despedida via IA, reativa para 7 dias e **bloqueia o contato** | Nenhum | - |

- **Reversão voluntária durante o delay (2ª vez):** Se o contato reativar as mensagens temporárias antes do delay terminar, o temporizador pendente é cancelado **sem contabilizar a infração**.
- **Reavaliação antes de agir:** O estado mais recente do chat é reavaliado imediatamente antes de qualquer reativação programada.
- **Cooldown:** Após a conclusão de uma intervenção, o contato entra em cooldown configurável (`COOLDOWN_HOURS`) para evitar ciclos repetitivos causados por instabilidades na rede.

### Auto-habilitação em chats legados (`auto_enabled_on_message`)

Para conversas antigas onde as mensagens temporárias nunca foram ativadas (`expiration === 0`):
- Ao receber qualquer mensagem normal do contato (texto, áudio, mídia, etc.), o bot ativa automaticamente a duração de 7 dias em silêncio.
- **Sem penalidade:** A ativação é silenciosa e não contabiliza infrações nem envia avisos de advertência.

### Suporte a Wildcard e Lista de Exceções

- **Modo Global:** Defina `ALLOWED_JIDS=*` para proteger todas as conversas individuais da conta.
- **Lista de Exceções (`EXCLUDED_JIDS`):** Permite listar números autorizados a desativar as mensagens temporárias sem sofrer punição (ex.: seu próprio número, contatos VIP ou suporte).
- **Formatos Flexíveis de Telefone:** Tanto `ALLOWED_JIDS` quanto `EXCLUDED_JIDS` aceitam números internacionais comuns com ou sem pontuação (ex.: `+55 21 99999-9999`, `5521999999999` ou `5521999999999@s.whatsapp.net`). A normalização é automática.

### Resolução Multi-Device (`@lid`) e Bloqueio Robusto

- O WhatsApp Web Multi-Device frequentemente entrega eventos identificando os usuários por LIDs (`@lid`).
- O sistema mantém um mapeamento bidirecional dinâmico entre `@lid` e o número de telefone real (`@s.whatsapp.net`), capturado a partir de metadados de mensagens (`senderPn`, `participantPn`, `remoteJidAlt`) e eventos da lista de contatos.
- **Bloqueio via Stanza IQ Composta:** Para evitar falhas `400 Bad Request` do protocolo do WhatsApp ao bloquear contatos que se comunicam via LID, o bot dispara stanzas IQ contendo simultaneamente os atributos `jid: <lid>` e `pn_jid: <numero>@s.whatsapp.net`.

### Notificações em Tempo Real no Telegram

Se configurado com `TELEGRAM_BOT_TOKEN` e `TELEGRAM_CHAT_ID`, o bot envia notificações estruturadas de auditoria:
- Reativações silenciosas.
- Avisos enviados com a frase gerada pela IA.
- Bloqueios executados.
- Auto-habilitações em conversas legadas.
- Falhas de envio ou rede.
- **Identificação Clara:** Exibe sempre o número de telefone real formatado (ex.: `+5521999999999`), resolvendo automaticamente o LID.

---

## Requisitos

- Node.js 20 ou superior
- npm
- Uma conta de WhatsApp para autenticar via QR Code
- Chave da OpenAI ou API compatível (opcional; sem ela, mensagens fallback pré-definidas são utilizadas)
- Bot no Telegram para alertas (opcional)

---

## Instalação

```bash
cd cansei
npm install
cp .env.example .env
```

Edite o `.env` com suas configurações. As pastas `auth/` e `data/` nunca devem ser versionadas.

---

## Configuração do `.env`

```dotenv
ALLOWED_JIDS=*
EXCLUDED_JIDS=5521999999999,5521888888888
EPHEMERAL_SECONDS=604800
COOLDOWN_HOURS=24
MIN_DELAY_MINUTES=1
MAX_DELAY_MINUTES=3
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4o-mini
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_TIMEOUT_MS=8000
OPENAI_MAX_RETRIES=0
OPENAI_TEMPERATURE=1.05
OPENAI_MAX_TOKENS=60
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
LOG_LEVEL=info
```

| Variável | Obrigatória | Padrão | Descrição |
| --- | --- | --- | --- |
| `ALLOWED_JIDS` | Sim | `*` | `*` para monitorar todas as conversas individuais, ou lista de números separados por vírgula. Aceita formatos com ou sem `+` e pontuação. |
| `EXCLUDED_JIDS` | Não | - | Lista de números isentos que nunca sofrem intervenção nem punição. |
| `EPHEMERAL_SECONDS` | Não | `604800` | Duração das mensagens ao reativar. Valores aceitos: `86400` (24h), `604800` (7 dias) ou `7776000` (90 dias). |
| `COOLDOWN_HOURS` | Não | `24` | Intervalo mínimo entre intervenções aceitas do mesmo contato. `0` desativa. |
| `MIN_DELAY_MINUTES` | Não | `1` | Limite inferior do delay aleatório antes de reativar na 2ª desativação. |
| `MAX_DELAY_MINUTES` | Não | `3` | Limite superior do delay aleatório. |
| `OPENAI_API_KEY` | Não | - | Chave de API da OpenAI (ou compatível) para gerar mensagens. Sem chave, usa fallbacks locais. |
| `OPENAI_MODEL` | Não | `gpt-4o-mini` | Modelo de IA para gerar o texto da mensagem. |
| `OPENAI_BASE_URL` | Não | `https://api.openai.com/v1` | Endpoint compatível com a API da OpenAI. |
| `OPENAI_TIMEOUT_MS` | Não | `8000` | Timeout da chamada em milissegundos. |
| `OPENAI_MAX_RETRIES` | Não | `0` | Quantidade de retries em falhas transitórias. |
| `OPENAI_TEMPERATURE` | Não | `1.05` | Temperatura de geração das frases. |
| `OPENAI_MAX_TOKENS` | Não | `60` | Limite máximo de tokens gerados. |
| `TELEGRAM_BOT_TOKEN` | Não | - | Token do bot do Telegram para notificações de auditoria. |
| `TELEGRAM_CHAT_ID` | Não | - | Chat ID de destino das notificações no Telegram. |
| `LOG_LEVEL` | Não | `info` | Nível de log: `fatal`, `error`, `warn`, `info`, `debug`, `trace` ou `silent`. |
| `AUTH_DIR` | Não | `auth` | Diretório onde a sessão do Baileys é persistida. |
| `DATA_DIR` | Não | `data` | Diretório onde `state.json` e `audit.jsonl` são armazenados. |

---

## Execução

### Desenvolvimento

```bash
npm run dev
```

### Produção

```bash
npm run build
npm start
```

No primeiro início, escaneie o QR Code exibido no terminal (ou nos logs do container). As credenciais da sessão são salvas em `auth/` e reutilizadas nos próximos inícios.

---

## Docker

Build e publicação da imagem:

```bash
docker build --platform linux/amd64 -t pedromol/cansei:latest .
docker push pedromol/cansei:latest
```

Execução local com volumes persistentes:

```bash
docker volume create cansei-auth
docker volume create cansei-data

docker run --rm -it \
  --env-file .env \
  -v cansei-auth:/app/auth \
  -v cansei-data:/app/data \
  pedromol/cansei:latest
```

---

## Kubernetes

O manifest de referência está disponível em [`k8s/deployment.yaml`](k8s/deployment.yaml). Ele inclui:

- `Namespace/cansei`
- `ConfigMap/cansei-config`
- `Secret/cansei-secrets`
- `PersistentVolumeClaim/cansei-storage` (1Gi RWO para manter `auth/` e `data/`)
- `Deployment/cansei` com estratégia `Recreate` e réplica única (`replicas: 1`).

> **Importante:** Cada sessão do WhatsApp Web exige exclusividade. Nunca aumente o número de réplicas.

```bash
kubectl apply -f k8s/deployment.yaml
kubectl -n cansei logs -f deploy/cansei
```

---

## Persistência e Auditoria

### `data/state.json`

Armazenamento atômico do estado de cada contato:

```json
{
  "version": 1,
  "updatedAt": "2026-01-01T00:00:00.000Z",
  "contacts": {
    "5521999999999@s.whatsapp.net": {
      "jid": "5521999999999@s.whatsapp.net",
      "offCount": 2,
      "lastOffAt": "2026-01-01T00:00:00.000Z",
      "lastActionAt": "2026-01-01T00:02:00.000Z",
      "cooldownUntil": "2026-01-02T00:02:00.000Z",
      "blocked": false,
      "blockedAt": null,
      "pending": false,
      "pendingUntil": null,
      "lastKnownExpiration": 604800
    }
  }
}
```

Se o arquivo de estado for corrompido, o sistema preserva uma cópia `state.json.corrupt-<timestamp>` e interrompe a inicialização de forma segura.

### `data/audit.jsonl`

Registro estruturado em JSON Lines para auditoria de todas as decisões tomadas:

```json
{"timestamp":"2026-01-01T00:00:00.000Z","jid":"5521999999999@s.whatsapp.net","event":"reactivated","detectedValue":0,"action":"reactivate","counter":1,"details":{"ephemeralSeconds":604800,"instant":true,"reason":"first_offense"}}
{"timestamp":"2026-01-01T00:10:00.000Z","jid":"5521999999999@s.whatsapp.net","event":"message_sent","detectedValue":0,"action":"send_message","counter":2,"details":{"text":"Prefiro manter as mensagens temporarias ativadas por aqui.","source":"llm","wordCount":8,"stage":"instant_warning"}}
```

Eventos suportados: `detected_disabled`, `auto_enabled_on_message`, `reactivated`, `message_sent`, `message_failed`, `contact_blocked`, `block_failed`, `skipped_blocked`, `skipped_pending`, `skipped_cooldown`, `action_cancelled`, `action_failed`, `blocked_externally`.

---

## Mensagens Geradas por IA (LLM)

- **Diretrizes Estritas:**
  - Frase única em português brasileiro, com limite de até 18 palavras.
  - Tom casual, neutro e direto; sem agressividade, ameaças ou acusações.
  - Nunca menciona bots, automações ou regras de sistema.
- **Tipos de Mensagem:**
  - **Aviso (2ª infração):** Frase curta indicando preferência por manter as mensagens temporárias ativadas.
  - **Despedida (3ª infração):** Frase casual e definitiva antes do bloqueio do contato.
- **Fallback Automático:** Caso a OpenAI esteja offline, sem chave ou retorne texto fora dos parâmetros de validação, uma mensagem fallback segura é selecionada automaticamente.

---

## Testes e Qualidade

O projeto conta com suíte abrangente de testes automatizados:

```bash
npm test          # Executa os 46 testes unitários
npm run typecheck # Verificação estrita de tipos TypeScript
npm run build     # Compilação limpa para dist/
```

---

## Limitações e Boas Práticas

1. **Protocolo Não Oficial:** Atualizações na arquitetura do WhatsApp podem demandar ajustes no Baileys.
2. **Uso Responsável:** Projetado para proteção da privacidade pessoal em conversas diretas. O risco operacional é de responsabilidade do usuário.
3. **Escopo:** O monitor opera exclusivamente em conversas 1 a 1 (ignora deliberadamente grupos, canais, status e newsletters).
