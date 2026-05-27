# SalesLeo — Personal Brand Consultant Bot

## Status (2026-05-28)

Active development. LINE OA sales bot for Leo's Personal Brand as Meta Ads consultant.

## Architecture

```
LINE Message → POST /webhook → Escalation Check → Gemini AI → Reply
                                    ↓ (if triggered)
                              Push notification → Leo's LINE
```

## Key Files

- `index.js` — Express server, webhook, escalation logic, Gemini integration
- `prompts/system.md` — System prompt (identity, services, response rules, intent flow)
- `knowledge/*.txt` — Auto-loaded into system prompt as knowledge base
- `.env` — Credentials (never commit)

## Escalation Tiers

| Tier | Trigger | Action |
|------|---------|--------|
| immediate | โอน/จ่าย/สัญญา/ไม่พอใจ/ขอคุยกับคน/ถามซ้ำ 3+ ครั้ง | Push notify Leo ทันที |
| within_1hr | แพ็คเกจ/งบ/เริ่มได้เลย/ใบเสนอราคา | Push notify Leo |
| auto | ทักทาย/ถามทั่วไป/ถามราคาเบื้องต้น | AI ตอบเอง |

## Knowledge System

Drop `.txt` or `.md` files into `knowledge/` — they auto-inject into the system prompt.
Bot uses them as real data to reference when answering customers.

## Deploy

Railway — `npm start` runs `node index.js`

## Rules

- ห้ามแต่ง case study / ตัวเลข ถ้าไม่มีใน knowledge
- ห้ามเปิดเผยชื่อลูกค้าจริง
- Content ต้องมาจาก knowledge หรือหลักการทั่วไป
