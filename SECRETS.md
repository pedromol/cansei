# Secrets do Repositório

> ⚠️ NUNCA commite valores reais. Use o ambiente de secrets do GitHub.

## Como configurar

```bash
# Via GitHub CLI (mais rápido):
gh secret set DOCKER_HUB_USERNAME -b'seu-usuario'
gh secret set DOCKER_HUB_TOKEN -b'seu-token'

# Ou via UI do GitHub:
# Settings → Secrets and variables → Actions → New repository secret
```

## Secrets disponíveis

| Nome | Obrigatório? | Descrição |
|------|--------------|-----------|
| `DOCKER_HUB_USERNAME` | Sim* | Usuário da Docker Hub |
| `DOCKER_HUB_TOKEN` | Sim* | Token de acesso Docker Hub |

\* Necessários se quiser publicar a imagem Docker automaticamente.

## Token Docker Hub

1. Acesse: https://hub.docker.com/settings/security
2. Clique "New Access Token"
3. Cole o token no campo `DOCKER_HUB_TOKEN`