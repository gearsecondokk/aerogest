# 🎬 Bot Telegram — vidéos IA (image → vidéo) avec fal.ai

Un bot Telegram où tu **discutes avec Claude** (API Anthropic) pour transformer une image en vidéo IA via l'API [fal.ai](https://fal.ai) :

- 🧠 **Une vraie conversation** : Claude voit ton image, te demande ce que tu veux, te conseille un modèle (Kling, Veo 3.1, Hailuo, Wan, Seedance) selon le besoin et le budget, rédige le prompt avec toi et l'affine à la demande.
- 🛠 **Claude pilote fal.ai avec des outils** : `estimate_cost`, `propose_generation`, `list_jobs`, `cancel_job` (tool use de l'API Claude).
- 💰 **Coût annoncé avant de payer** : `propose_generation` affiche une carte récapitulative (modèle, options, prompt, coût estimé + tarif live fal.ai) avec des boutons ✅ / ❌. Le lancement est verrouillé en code : rien ne part sans ton ✅.
- 🎥 **Livraison automatique** : suivi de la file d'attente fal.ai, la vidéo est envoyée dans Telegram dès qu'elle est prête, et Claude en est informé pour continuer la conversation. Les jobs survivent à un redémarrage.
- 🔒 **Garde-fous** : liste blanche d'utilisateurs, plafond par vidéo, budget journalier optionnel.

## Modèles et tarifs (fal.ai, septembre 2026)

| Modèle | Endpoint fal.ai | Options | Tarif |
|---|---|---|---|
| Kling 2.5 Turbo Pro | `fal-ai/kling-video/v2.5-turbo/pro/image-to-video` | 5 / 10 s | 0,07 $/s (5 s = 0,35 $) |
| Google Veo 3.1 | `fal-ai/veo3.1/image-to-video` | 4/6/8 s, 720p/1080p/4K, audio | 0,20 $/s sans audio, 0,40 $/s avec (4K : 0,40 / 0,60) |
| MiniMax Hailuo 02 Standard | `fal-ai/minimax/hailuo-02/standard/image-to-video` | 6 / 10 s, 512p/768p | 0,045 $/s (768p), 0,017 $/s (512p) |
| MiniMax Hailuo 02 Pro | `fal-ai/minimax/hailuo-02/pro/image-to-video` | 6 s, 1080p | 0,08 $/s |
| Wan 2.5 | `fal-ai/wan-25-preview/image-to-video` | 5 / 10 s, 480p/720p/1080p | 0,05 / 0,10 / 0,15 $/s |
| Seedance 1.0 Pro | `fal-ai/bytedance/seedance/v1/pro/image-to-video` | 3 à 12 s, 480p/720p/1080p | 2,5 $ / M tokens vidéo (1080p 5 s ≈ 0,62 $) |

Les prix sont codés dans `src/models.ts` ; le bot affiche aussi le tarif unitaire renvoyé en direct par `GET https://api.fal.ai/v1/models/pricing`. Vérifie les pages fal.ai des modèles si les tarifs évoluent.

## Installation

Prérequis : Node.js ≥ 22.

```bash
npm install
cp .env.example .env   # puis remplis les clés
npm run dev            # développement (rechargement auto)
```

Production :

```bash
npm run build
npm start
# ou avec Docker
docker compose up -d --build
```

### Clés à renseigner dans `.env`

| Variable | Où l'obtenir |
|---|---|
| `TELEGRAM_BOT_TOKEN` | [@BotFather](https://t.me/BotFather) → `/newbot` |
| `FAL_KEY` | [fal.ai dashboard → Keys](https://fal.ai/dashboard/keys) |
| `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com) (l'IA qui discute avec toi) |
| `ALLOWED_USER_IDS` | Ton ID Telegram, affiché par la commande `/id` du bot |

Autres réglages : `CLAUDE_MODEL` (défaut `claude-opus-5`), `CLAUDE_EFFORT` (`low`…`max`, défaut `medium`), `HISTORY_MAX_MESSAGES` (défaut 40), `MAX_COST_PER_VIDEO_USD` (défaut 5), `DAILY_BUDGET_USD` (optionnel), `POLL_INTERVAL_MS`, `DATA_DIR`.

Le bot active par défaut le repli serveur en cas de refus de Claude (`fallbacks: "default"`) ; si ton organisation n'y a pas accès, il réessaie automatiquement sans.

## Utilisation

1. `/start` puis envoie une **image** (photo ou fichier image), avec ou sans légende.
2. **Parle normalement** : « fais tourner la caméra autour, ambiance nuit, 10 s, pas trop cher ». Claude décrit ce qu'il voit, propose un modèle avec son prix et un prompt en anglais ; tu discutes jusqu'à être satisfait.
3. Quand tu valides, Claude appelle `propose_generation` : une carte **récapitulatif + coût estimé** apparaît → ✅ Oui / ❌ Non.
4. Un message de statut se met à jour (file d'attente, génération en cours, bouton Annuler), puis la **vidéo arrive** dans le chat. Tu peux enchaîner (« la même en Veo avec du son »).

Commandes : `/models`, `/jobs`, `/history`, `/new` (nouvelle conversation), `/id`.

## Structure

```
src/
├── index.ts          # démarrage : bot + boucle de suivi des jobs
├── bot.ts            # commandes Telegram, réception images/texte, boutons ✅/❌, lancement des jobs
├── agent.ts          # agent Claude : system prompt (catalogue), outils, boucle tool runner, historique
├── jobs.ts           # polling de la file fal.ai, envoi des vidéos, notifications à Claude
├── models.ts         # registre des modèles (endpoints, options, prix, payloads, guides de prompt)
├── pricing.ts        # estimation des coûts + API pricing fal.ai
├── fal.ts            # client fal.ai (upload image, submit/status/result/cancel)
├── store.ts          # persistance JSON (sessions, jobs, dépenses)
├── telegram-files.ts # téléchargement des images Telegram
└── text.ts           # helpers HTML
```

Les données (conversations, jobs, dépenses) sont dans `data/state.json`. L'historique de chaque conversation est borné (`HISTORY_MAX_MESSAGES`) et l'image courante est réinjectée si elle sort de la fenêtre.

## Ajouter un modèle

Ajoute une entrée dans `MODELS` (`src/models.ts`) : endpoint, options proposées, formule de prix, guide de prompting pour Claude, et `buildInput` qui construit le payload attendu par fal.ai (voir la page « API » du modèle sur fal.ai).
