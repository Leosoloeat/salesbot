'use strict';
require('dotenv').config();

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const line = require('@line/bot-sdk');

const PORT = parseInt(process.env.PORT || '3000', 10);
const LINE_SECRET = process.env.LINE_CHANNEL_SECRET || '';
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_MODEL = process.env.AI_MODEL || 'google/gemini-2.5-flash';
const AI_PROVIDER = process.env.AI_PROVIDER || (OPENROUTER_KEY ? 'openrouter' : 'gemini');
const OWNER_USER_ID = process.env.OWNER_USER_ID
  || (process.env.ADMIN_USER_IDS || '').split(',')[0].trim()
  || '';

const lineClient = new line.messagingApi.MessagingApiClient({
  channelAccessToken: LINE_TOKEN,
});

// ── Conversation History (in-memory, last 10 turns per user) ──

const history = new Map();

function getHistory(userId) {
  if (!history.has(userId)) history.set(userId, []);
  return history.get(userId);
}

function pushHistory(userId, role, text) {
  const h = getHistory(userId);
  h.push({ role, parts: [{ text }] });
  if (h.length > 20) h.splice(0, 2);
}

// ── Escalation Detection ──

const ESCALATE_IMMEDIATE = [
  'โอน', 'จ่าย', 'ราคาจริง', 'สัญญา', 'ตกลง',
  'แย่', 'ไม่ดี', 'หลอก', 'โกง', 'ห่วย',
  'ไม่พอใจ', 'ร้องเรียน', 'คืนเงิน',
];

const ESCALATE_1HR = [
  'แพ็คเกจ', 'package', 'timeline', 'เมื่อไหร่เริ่ม',
  'งบ', 'budget', 'เริ่มได้เลย', 'เอาเลย',
  'ใบเสนอราคา', 'quotation', 'invoice',
];

const WANT_HUMAN = [
  'ขอคุยกับคน', 'คุยกับคนได้ไหม', 'เจ้าของอยู่ไหม',
  'ขอเบอร์', 'โทรได้ไหม', 'ขอติดต่อ', 'อยากคุยกับ leo',
];

const PHONE_RE = /0[689]\d[\s-]?\d{3,4}[\s-]?\d{3,4}/;

const repeatTracker = new Map();
const pendingContact = new Map();

function detectEscalation(userId, text) {
  const lower = text.toLowerCase();

  if (pendingContact.has(userId)) {
    const phoneMatch = text.match(PHONE_RE);
    if (phoneMatch) {
      const info = pendingContact.get(userId);
      info.phone = phoneMatch[0].replace(/[\s-]/g, '');
      info.rawMessage = text;
      pendingContact.delete(userId);
      return { tier: 'contact_ready', contactInfo: info };
    }
  }

  for (const kw of WANT_HUMAN) {
    if (lower.includes(kw)) {
      pendingContact.set(userId, { requestedAt: Date.now() });
      return { tier: 'collecting', contactInfo: null };
    }
  }

  for (const kw of ESCALATE_IMMEDIATE) {
    if (lower.includes(kw)) return { tier: 'immediate', contactInfo: null };
  }

  if (!repeatTracker.has(userId)) repeatTracker.set(userId, []);
  const prev = repeatTracker.get(userId);
  const sameCount = prev.filter(t => t === lower).length;
  prev.push(lower);
  if (prev.length > 10) prev.shift();
  if (sameCount >= 2) return { tier: 'immediate', contactInfo: null };

  for (const kw of ESCALATE_1HR) {
    if (lower.includes(kw)) return { tier: 'within_1hr', contactInfo: null };
  }

  if (PHONE_RE.test(text)) {
    return {
      tier: 'contact_ready',
      contactInfo: { phone: text.match(PHONE_RE)[0].replace(/[\s-]/g, ''), rawMessage: text },
    };
  }

  return { tier: 'auto', contactInfo: null };
}

// ── LINE Profile ──

async function getLineProfile(userId) {
  try {
    const profile = await lineClient.getProfile(userId);
    return { name: profile.displayName, pic: profile.pictureUrl || '' };
  } catch {
    return { name: null, pic: '' };
  }
}

// ── Notify Owner via LINE Push ──

async function notifyOwner(userId, userText, tier, contactInfo) {
  if (!OWNER_USER_ID) {
    console.warn('[escalation] OWNER_USER_ID not set — skip');
    return;
  }

  const tierLabels = {
    immediate: '🔴 ด่วน',
    within_1hr: '🟡 ภายใน 1 ชม.',
    contact_ready: '📞 ลูกค้าทิ้งเบอร์แล้ว',
  };
  const label = tierLabels[tier] || tier;

  const profile = await getLineProfile(userId);
  const displayName = profile.name || userId.slice(0, 10) + '...';

  const recent = getHistory(userId)
    .slice(-6)
    .map(h => `${h.role === 'user' ? '👤' : '🤖'} ${h.parts[0].text.slice(0, 80)}`)
    .join('\n');

  const lines = [
    `${label} — แจ้งเตือนจาก SalesBot`,
    '',
    `👤 ${displayName}`,
    `ข้อความ: ${userText.slice(0, 200)}`,
  ];

  if (contactInfo?.phone) {
    lines.push('', `📱 เบอร์: ${contactInfo.phone}`);
    if (contactInfo.rawMessage && contactInfo.rawMessage !== userText) {
      lines.push(`ข้อความเต็ม: ${contactInfo.rawMessage.slice(0, 200)}`);
    }
  }

  if (recent) {
    lines.push('', `บทสนทนา:\n${recent}`);
  }

  try {
    await lineClient.pushMessage({
      to: OWNER_USER_ID,
      messages: [{ type: 'text', text: lines.join('\n') }],
    });
    console.log(`[escalation] notified owner tier=${tier} user=${userId.slice(0, 10)}`);
  } catch (err) {
    console.error('[escalation] push failed:', err.message);
  }
}

// ── System Prompt + Knowledge Loading ──

function loadSystemPrompt() {
  let prompt = '';
  try {
    prompt = fs.readFileSync(path.join(__dirname, 'prompts/system.md'), 'utf8');
  } catch {
    prompt = 'คุณคือ AI ผู้ช่วยของ Leo — ผู้เชี่ยวชาญยิงแอด Meta สำหรับธุรกิจ SME ไทย';
  }

  const knowledgeDir = path.join(__dirname, 'knowledge');
  try {
    const files = fs.readdirSync(knowledgeDir)
      .filter(f => (f.endsWith('.txt') || f.endsWith('.md')) && f !== 'README.md');

    if (files.length > 0) {
      prompt += '\n\nKNOWLEDGE BASE (ข้อมูลจากประสบการณ์จริง — ใช้อ้างอิงได้เลย)\n';
      for (const file of files) {
        const content = fs.readFileSync(path.join(knowledgeDir, file), 'utf8').trim();
        if (content) {
          prompt += `\n--- ${file.replace(/\.(txt|md)$/, '')} ---\n${content}\n`;
        }
      }
    }
  } catch {}

  return prompt;
}

// ── AI Providers ──

async function callOpenRouter(userId, userText) {
  const systemPrompt = loadSystemPrompt();
  const userHistory = getHistory(userId);

  const messages = [{ role: 'system', content: systemPrompt }];
  for (const h of userHistory) {
    messages.push({
      role: h.role === 'user' ? 'user' : 'assistant',
      content: h.parts[0].text,
    });
  }
  messages.push({ role: 'user', content: userText });

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages,
      max_tokens: 500,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenRouter ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  return (data.choices?.[0]?.message?.content || '').trim();
}

async function callGemini(userId, userText) {
  const genAI = new GoogleGenerativeAI(GEMINI_KEY);
  const model = genAI.getGenerativeModel({
    model: GEMINI_MODEL,
    systemInstruction: loadSystemPrompt(),
  });

  const chat = model.startChat({ history: getHistory(userId) });
  const result = await chat.sendMessage(userText);
  return result.response.text().trim();
}

async function generateReply(userId, userText) {
  let reply;

  if (AI_PROVIDER === 'openrouter' && OPENROUTER_KEY) {
    reply = await callOpenRouter(userId, userText);
  } else if (GEMINI_KEY) {
    reply = await callGemini(userId, userText);
  } else {
    throw new Error('No AI provider configured');
  }

  pushHistory(userId, 'user', userText);
  pushHistory(userId, 'model', reply);

  return reply;
}

// ── LINE Messaging ──

function verifySignature(rawBody, signature) {
  const hash = crypto
    .createHmac('sha256', LINE_SECRET)
    .update(rawBody)
    .digest('base64');
  return hash === signature;
}

async function replyToLine(replyToken, text) {
  await lineClient.replyMessage({
    replyToken,
    messages: [{ type: 'text', text }],
  });
}

// ── Express Server ──

const app = express();

app.use((req, _res, next) => {
  console.log(`[req] ${req.method} ${req.path}`);
  next();
});

app.post('/webhook', express.raw({ type: '*/*', limit: '2mb' }), async (req, res) => {
  const aiReady = (AI_PROVIDER === 'openrouter' && OPENROUTER_KEY) || GEMINI_KEY;
  if (!LINE_SECRET || !LINE_TOKEN || !aiReady) {
    console.error('[webhook] missing env vars');
    return res.status(200).send('not configured');
  }

  let body;
  try {
    body = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.status(400).send('bad json');
  }

  const events = Array.isArray(body.events) ? body.events : [];
  if (events.length === 0) return res.status(200).send('ok');

  const signature = req.get('x-line-signature') || '';
  if (!verifySignature(req.body, signature)) {
    console.warn('[webhook] bad signature — continuing for debug');
  }

  res.status(200).send('ok');

  for (const event of events) {
    if (event.type !== 'message' || event.message?.type !== 'text') continue;

    const userId = event.source?.userId || 'unknown';
    const userText = event.message.text || '';
    const replyToken = event.replyToken;

    console.log(`[msg] user=${userId.slice(0, 10)} text="${userText.slice(0, 50)}"`);

    // Skip AI response for admin/owner — Leo ทักเข้ามาเอง ไม่ต้องตอบ
    if (userId === OWNER_USER_ID) {
      console.log('[msg] owner message — skipping AI response');
      continue;
    }

    const { tier, contactInfo } = detectEscalation(userId, userText);

    if (tier === 'immediate' || tier === 'within_1hr' || tier === 'contact_ready') {
      notifyOwner(userId, userText, tier, contactInfo).catch(err =>
        console.error('[escalation] bg error:', err.message)
      );
    }

    try {
      const reply = await generateReply(userId, userText);
      console.log(`[ai] reply="${reply.slice(0, 50)}"`);
      await replyToLine(replyToken, reply);
    } catch (err) {
      console.error('[webhook] error:', err.message);
      try {
        await replyToLine(replyToken, 'ขออภัยครับ ระบบขัดข้องชั่วคราว กรุณาลองใหม่อีกสักครู่นะครับ');
      } catch {}
    }
  }
});

app.get('/health', (_req, res) => res.json({ ok: true, t: Date.now(), provider: AI_PROVIDER }));

app.listen(PORT, () => {
  console.log(`[SalesBot] port=${PORT} provider=${AI_PROVIDER} model=${AI_PROVIDER === 'openrouter' ? OPENROUTER_MODEL : GEMINI_MODEL}`);
  if (!LINE_SECRET || !LINE_TOKEN) console.warn('[SalesBot] LINE credentials missing');
  if (AI_PROVIDER === 'openrouter' && !OPENROUTER_KEY) console.warn('[SalesBot] OPENROUTER_API_KEY missing');
  if (AI_PROVIDER === 'gemini' && !GEMINI_KEY) console.warn('[SalesBot] GEMINI_API_KEY missing');
  if (!OWNER_USER_ID) console.warn('[SalesBot] OWNER_USER_ID missing — escalation disabled');
});
