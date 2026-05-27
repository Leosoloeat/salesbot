# SalesLeo — LINE OA Sales Bot for Meta Ads Consulting

Standalone LINE OA bot for Leo's Personal Brand as Meta Ads consultant.
Gemini-powered, auto-escalation to owner, knowledge base auto-loading.

## Architecture

```
LINE Message → POST /webhook → Escalation Check → Gemini AI → Reply
                                    ↓ (if triggered)
                              Push notification → Leo's LINE
```

## Quick Start (Local Dev)

```bash
npm install
npm run dev
```

Expose with ngrok:
```bash
ngrok http 3000
```

## Files

```
SalesLeo/
├── index.js              — server (Express + LINE webhook + Gemini + escalation)
├── prompts/system.md     — bot personality & response rules
├── knowledge/            — auto-loaded into system prompt
│   ├── ads_framework.txt
│   ├── case_studies.txt
│   └── faq.txt
├── .env                  — credentials (never commit)
├── railway.json          — Railway deploy config
└── Procfile              — process declaration
```

## Environment Variables

| Key | Required | Description |
|-----|----------|-------------|
| LINE_CHANNEL_SECRET | Yes | LINE Developers → Channel Basic Settings |
| LINE_CHANNEL_ACCESS_TOKEN | Yes | LINE Developers → Messaging API |
| GEMINI_API_KEY | Yes | aistudio.google.com/app/apikey |
| GEMINI_MODEL | No | Default: gemini-2.5-flash |
| OWNER_USER_ID | Yes | Leo's LINE User ID for escalation push |
| PORT | No | Default: 3000 |

## Deploy to Railway

Push to GitHub → Railway auto-deploys from `Leosoloeat/salesbot` repo.

## Knowledge System

Drop .txt or .md files into `knowledge/` — they auto-inject into the system prompt.
Bot uses them as real data to reference when answering customers.
Edit `prompts/system.md` to change bot personality (reloads without restart).
