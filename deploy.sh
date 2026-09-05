#!/bin/bash
# Déploie le bot sur le VPS — à lancer depuis ta machine.
# Usage : bash deploy.sh
set -e

SERVER="${SERVER:-root@65.21.229.176}"
DIR="${DIR:-/opt/video-bot}"
BRANCH="${BRANCH:-claude/telegram-ai-video-bot-gt0skd}"

echo "🚀 Déploiement du bot vidéo sur $SERVER:$DIR ($BRANCH)"
ssh "$SERVER" "cd $DIR && git fetch origin $BRANCH && git checkout $BRANCH && git pull origin $BRANCH"
ssh "$SERVER" "cd $DIR && npm ci && npm run build"
ssh "$SERVER" "cd $DIR && pm2 startOrRestart ecosystem.config.cjs && pm2 save"
echo "✅ Déployé. Logs : ssh $SERVER 'pm2 logs video-bot'"
