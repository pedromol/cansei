#!/bin/bash
# Script para configurar secrets do GitHub
# Substitua pelos valores e execute:
#  gh secret set NOME -b"valor"

echo "Configurando secrets do repositório..."
echo ""
echo "Commands a executar (via GitHub CLI ou UI):"
echo ""
echo "# Docker Hub - obrigatório se quiser publicar imagens"
echo "gh secret set DOCKER_HUB_USERNAME -b''"
echo "gh secret set DOCKER_HUB_TOKEN -b''"
echo ""
echo "# (Opcional) Variáveis de ambiente para staging"
echo "gh secret set NODE_ENV -b'staging'"