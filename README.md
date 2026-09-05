# 🎬 Bot Telegram — vidéos IA (image → vidéo) avec fal.ai

Un bot Telegram qui transforme une image en vidéo IA via l'API [fal.ai](https://fal.ai), avec :

- 🖼 **Image → vidéo** : envoie une photo, choisis un modèle (Kling, Veo 3.1, Hailuo, Wan, Seedance) et ses options.
- 🧠 **Assistant de prompt (Claude)** : décris ton idée en français, Claude regarde l'image et propose un prompt optimisé pour le modèle choisi. Tu affines en discutant, tu demandes une variante, ou tu écris le prompt toi-même.
- 💰 **Coût annoncé avant de lancer** : estimation locale + tarif live de l'API pricing fal.ai, puis confirmation ✅ / ❌.
- 🎥 **Livraison automatique** : suivi de la file d'attente fal.ai, la vidéo est envoyée dans Telegram dès qu'elle est prête (les jobs survivent à un redémarrage).
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
| `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com) (assistant de prompt) |
| `ALLOWED_USER_IDS` | Ton ID Telegram, affiché par la commande `/id` du bot |

Autres réglages : `CLAUDE_MODEL` (défaut `claude-opus-5`), `MAX_COST_PER_VIDEO_USD` (défaut 5), `DAILY_BUDGET_USD` (optionnel), `POLL_INTERVAL_MS`, `DATA_DIR`.

## Utilisation

1. `/start` puis envoie une **image** (photo ou fichier image).
2. Choisis le **modèle** avec les boutons, puis ses options (durée, résolution, audio…).
3. **Décris ton idée** en français. Le bot répond avec un prompt en anglais, une explication et éventuellement une question.
   - ✅ *Valider ce prompt* · 🔄 *Autre proposition* · ✍️ *Prompt manuel*
   - ou envoie simplement tes remarques (« plus lent », « caméra qui tourne autour ») pour l'affiner.
4. Le bot affiche le **récapitulatif et le coût estimé** → ✅ Oui / ❌ Non.
5. Un message de statut se met à jour (file d'attente, génération en cours), puis la **vidéo arrive** dans le chat. `/again` relance avec la même image.

Commandes : `/models`, `/jobs`, `/history`, `/again`, `/cancel`, `/id`.

## Structure

```
src/
├── index.ts          # démarrage : bot + boucle de suivi des jobs
├── bot.ts            # commandes Telegram, boutons, machine à états par chat
├── jobs.ts           # polling de la file fal.ai, envoi des vidéos
├── models.ts         # registre des modèles (endpoints, options, prix, payloads)
├── pricing.ts        # estimation des coûts + API pricing fal.ai
├── prompter.ts       # assistant de prompt Claude (sortie structurée, vision)
├── fal.ts            # client fal.ai (upload image, submit/status/result/cancel)
├── store.ts          # persistance JSON (sessions, jobs, dépenses)
├── telegram-files.ts # téléchargement des images Telegram
└── text.ts           # helpers HTML
```

Les données (sessions, jobs, dépenses) sont dans `data/state.json`.

## Ajouter un modèle

Ajoute une entrée dans `MODELS` (`src/models.ts`) : endpoint, options proposées, formule de prix, guide de prompting pour Claude, et `buildInput` qui construit le payload attendu par fal.ai (voir la page « API » du modèle sur fal.ai).
