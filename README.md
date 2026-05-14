# SalesBot — Leo Ai LINE OA Sales Assistant

> Gemini-powered sales bot for LINE OA.
> Sells ebooks + AI services automatically.
> Separate deployment from LeoSP.

---

## Quick Start (Local Dev)

```bash
npm install
# ใส่ token ใน .env ให้ครบก่อน
npm run dev
```

แล้วใช้ ngrok expose:
```bash
ngrok http 3000
```

ไปที่ LINE Developers Console → Messaging API → Webhook URL:
```
https://YOUR-NGROK-URL/webhook
```

---

## Deploy to Railway

1. Push to GitHub repo ใหม่
2. Railway → New Project → Deploy from GitHub
3. ใส่ Environment Variables:
   - `LINE_CHANNEL_SECRET`
   - `LINE_CHANNEL_ACCESS_TOKEN`
   - `GEMINI_API_KEY`
   - `GEMINI_MODEL` = `gemini-2.5-flash`
4. Railway จะให้ domain → ใส่เป็น webhook URL ใน LINE Console

---

## Files

```
SalesBot/
├── index.js          — main server (Express + LINE webhook + Gemini)
├── prompts/
│   └── system.md     — SalesBot personality (edit ตรงนี้เลย)
├── .env              — credentials (ห้าม commit)
├── railway.json      — Railway deploy config
└── Procfile          — process declaration
```

---

## Credentials Required

| Key | Source |
|---|---|
| LINE_CHANNEL_SECRET | LINE Developers → Channel Basic Settings |
| LINE_CHANNEL_ACCESS_TOKEN | LINE Developers → Messaging API → Long-lived token |
| GEMINI_API_KEY | aistudio.google.com/app/apikey |

---

## Edit Bot Personality

แก้ไขที่ `prompts/system.md` — bot จะโหลด prompt ใหม่ทันทีโดยไม่ต้อง restart
