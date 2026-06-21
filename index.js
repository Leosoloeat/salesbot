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
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10);
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || '60', 10);

// ── Facebook Messenger (optional — only active if tokens are set) ──
const FB_PAGE_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN || process.env.PAGE_ACCESS_TOKEN || '';
const FB_VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN || process.env.VERIFY_TOKEN || '';
const FB_APP_SECRET = process.env.FB_APP_SECRET || process.env.APP_SECRET || '';
const FB_GRAPH_VERSION = process.env.GRAPH_API_VERSION || 'v25.0';
const FB_ENABLED = Boolean(FB_PAGE_TOKEN);

const lineClient = new line.messagingApi.MessagingApiClient({
  channelAccessToken: LINE_TOKEN,
});

// ── Conversation History (in-memory, last 10 turns per user) ──

const history = new Map();
const rateBuckets = new Map();

function getErrorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

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
  'โอน', 'โอนแล้ว', 'สลิป', 'จ่าย', 'จ่ายแล้ว', 'ราคาจริง', 'สัญญา', 'ตกลง',
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
  } catch (err) {
    console.warn(`[profile] fetch failed user=${userId.slice(0, 10)} error=${getErrorMessage(err)}`);
    return { name: null, pic: '' };
  }
}

// ── Notify Owner via LINE Push ──

async function notifyOwner(userKey, userText, tier, contactInfo, opts = {}) {
  if (!OWNER_USER_ID) {
    console.warn('[escalation] OWNER_USER_ID not set — skip');
    return;
  }

  const channel = opts.channel || 'line';
  const tierLabels = {
    immediate: '🔴 ด่วน',
    within_1hr: '🟡 ภายใน 1 ชม.',
    contact_ready: '📞 ลูกค้าทิ้งเบอร์แล้ว',
  };
  const label = tierLabels[tier] || tier;
  const channelTag = channel === 'fb' ? ' [Messenger]' : ' [LINE]';

  let displayName;
  if (channel === 'line' && opts.displayId) {
    const profile = await getLineProfile(opts.displayId);
    displayName = profile.name || opts.displayId.slice(0, 10) + '...';
  } else {
    displayName = `ลูกค้า Messenger (${(opts.displayId || '').slice(0, 8)}...)`;
  }

  const recent = getHistory(userKey)
    .slice(-6)
    .map(h => `${h.role === 'user' ? '👤' : '🤖'} ${h.parts[0].text.slice(0, 80)}`)
    .join('\n');

  const lines = [
    `${label} — แจ้งเตือนจาก SalesBot${channelTag}`,
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
    console.error('[escalation] push failed:', getErrorMessage(err));
  }
}

// ── System Prompt + Knowledge Loading ──

function loadSystemPrompt() {
  let prompt = '';
  try {
    prompt = fs.readFileSync(path.join(__dirname, 'prompts/system.md'), 'utf8');
  } catch (err) {
    console.warn(`[prompt] load failed error=${getErrorMessage(err)}`);
    prompt = 'คุณคือ AI ผู้ช่วยของ Leo — ผู้เชี่ยวชาญยิงแอด Meta สำหรับธุรกิจ SME ไทย';
  }

  const knowledgeDir = path.join(__dirname, 'knowledge');
  try {
    const files = fs.readdirSync(knowledgeDir)
      .filter(f => (f.endsWith('.txt') || f.endsWith('.md')) && f !== 'README.md');

    if (files.length > 0) {
      prompt += '\n\nKNOWLEDGE BASE (ข้อมูลจากประสบการณ์จริง — ใช้อ้างอิงได้เลย)\n';
      for (const file of files) {
        try {
          const content = fs.readFileSync(path.join(knowledgeDir, file), 'utf8').trim();
          if (content) {
            prompt += `\n--- ${file.replace(/\.(txt|md)$/, '')} ---\n${content}\n`;
          }
        } catch (err) {
          console.warn(`[knowledge] file load failed file=${file} error=${getErrorMessage(err)}`);
        }
      }
    }
  } catch (err) {
    console.warn(`[knowledge] directory load failed dir=${knowledgeDir} error=${getErrorMessage(err)}`);
  }

  return prompt;
}

// ── AI Providers ──

async function callOpenRouter(userId, userText, model = OPENROUTER_MODEL) {
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
      model,
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

function sanitizeReply(text) {
  // LINE/Messenger ไม่ render markdown — ตัดสัญลักษณ์ที่จะโชว์ดิบทิ้ง
  return String(text || '')
    .replace(/\*\*/g, '')
    .replace(/(^|\s)\*(?=\S)/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/```/g, '')
    .replace(/^\s*---+\s*$/gm, '')
    .trim();
}

async function generateReply(userId, userText) {
  let reply;

  if (AI_PROVIDER === 'openrouter' && OPENROUTER_KEY) {
    const FALLBACK_MODEL = 'google/gemini-2.5-flash';
    try {
      reply = await callOpenRouter(userId, userText);
    } catch (err) {
      const m = getErrorMessage(err);
      if (OPENROUTER_MODEL !== FALLBACK_MODEL && /\b40[04]\b|No endpoints|not a valid model|is not available/i.test(m)) {
        console.warn(`[ai] model "${OPENROUTER_MODEL}" failed (${m.slice(0, 80)}) — retrying "${FALLBACK_MODEL}"`);
        reply = await callOpenRouter(userId, userText, FALLBACK_MODEL);
      } else {
        throw err;
      }
    }
  } else if (GEMINI_KEY) {
    reply = await callGemini(userId, userText);
  } else {
    throw new Error('No AI provider configured');
  }

  reply = sanitizeReply(reply);

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

// ── Facebook Messenger send + signature ──

async function sendMessenger(psid, text) {
  if (!FB_PAGE_TOKEN) {
    console.warn('[fb] FB_PAGE_ACCESS_TOKEN not set — skip reply');
    return;
  }
  const url = `https://graph.facebook.com/${FB_GRAPH_VERSION}/me/messages?access_token=${encodeURIComponent(FB_PAGE_TOKEN)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_type: 'RESPONSE',
      recipient: { id: psid },
      message: { text },
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Messenger Send API ${res.status}: ${detail.slice(0, 200)}`);
  }
}

function verifyMetaSignature(rawBody, signatureHeader) {
  // If no app secret configured, skip (dev/early setup). Set FB_APP_SECRET in production.
  if (!FB_APP_SECRET) {
    console.warn('[fb] FB_APP_SECRET not set — skipping signature check');
    return true;
  }
  if (!signatureHeader || !rawBody) return false;
  const [algo, received] = signatureHeader.split('=');
  if (algo !== 'sha256' || !received) return false;
  const expected = crypto.createHmac('sha256', FB_APP_SECRET).update(rawBody).digest('hex');
  if (received.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(received, 'hex'), Buffer.from(expected, 'hex'));
}

// ── Shared message pipeline (channel-agnostic) ──

async function processMessage({ channel, userKey, displayId, userText, sendReply }) {
  const { tier, contactInfo } = detectEscalation(userKey, userText);

  if (tier === 'immediate' || tier === 'within_1hr' || tier === 'contact_ready') {
    notifyOwner(userKey, userText, tier, contactInfo, { channel, displayId }).catch(err =>
      console.error('[escalation] bg error:', getErrorMessage(err))
    );
  }

  try {
    const reply = await generateReply(userKey, userText);
    console.log(`[ai] channel=${channel} reply="${reply.slice(0, 50)}"`);
    await sendReply(reply);
  } catch (err) {
    console.error(`[${channel}] error:`, getErrorMessage(err));
    try {
      await sendReply('ขออภัยครับ ระบบขัดข้องชั่วคราว กรุณาลองใหม่อีกสักครู่นะครับ');
    } catch (replyErr) {
      console.error(`[${channel}] fallback reply failed:`, getErrorMessage(replyErr));
    }
  }
}

// ── Express Server ──

function getClientKey(req) {
  const forwarded = req.get('x-forwarded-for') || '';
  return forwarded.split(',')[0].trim() || req.ip || 'unknown';
}

function isRateLimited(key) {
  const now = Date.now();
  const bucket = rateBuckets.get(key);

  if (!bucket || now - bucket.startedAt >= RATE_LIMIT_WINDOW_MS) {
    rateBuckets.set(key, { startedAt: now, count: 1 });
    return false;
  }

  bucket.count += 1;
  return bucket.count > RATE_LIMIT_MAX;
}

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

  const clientKey = getClientKey(req);
  if (isRateLimited(clientKey)) {
    console.warn(`[webhook] rate limited client=${clientKey}`);
    return res.status(429).send('rate limited');
  }

  const webhookSignature = req.get('x-line-signature') || '';
  if (!verifySignature(req.body, webhookSignature)) {
    console.warn(`[webhook] rejected bad signature client=${clientKey}`);
    return res.status(401).send('bad signature');
  }

  let body;
  try {
    body = JSON.parse(req.body.toString('utf8'));
  } catch (err) {
    console.warn(`[webhook] bad json client=${clientKey} error=${getErrorMessage(err)}`);
    return res.status(400).send('bad json');
  }

  const events = Array.isArray(body.events) ? body.events : [];
  if (events.length === 0) return res.status(200).send('ok');

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

    await processMessage({
      channel: 'line',
      userKey: userId,
      displayId: userId,
      userText,
      sendReply: (text) => replyToLine(replyToken, text),
    });
  }
});

// ── Facebook Messenger webhook ──

app.get('/fb/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === FB_VERIFY_TOKEN) {
    console.log('[fb] webhook verified by Meta');
    return res.status(200).send(challenge);
  }
  console.warn('[fb] webhook verify failed');
  return res.sendStatus(403);
});

app.post(
  '/fb/webhook',
  express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }),
  async (req, res) => {
    if (!FB_ENABLED) return res.status(200).send('fb not configured');
    if (!verifyMetaSignature(req.rawBody, req.get('x-hub-signature-256'))) {
      console.warn('[fb] bad signature');
      return res.sendStatus(401);
    }

    const body = req.body || {};
    if (body.object !== 'page') return res.sendStatus(404);
    res.status(200).send('EVENT_RECEIVED');

    for (const entry of body.entry || []) {
      for (const event of entry.messaging || []) {
        try {
          if (event.message?.is_echo) continue; // skip the page's own messages
          const psid = event.sender?.id;
          const text = event.message?.text;
          if (!psid || !text) continue; // v1: text only
          console.log(`[fb] msg psid=${psid.slice(0, 8)} text="${text.slice(0, 50)}"`);
          await processMessage({
            channel: 'fb',
            userKey: `fb:${psid}`,
            displayId: psid,
            userText: text,
            sendReply: (t) => sendMessenger(psid, t),
          });
        } catch (err) {
          console.error('[fb] handler error:', getErrorMessage(err));
        }
      }
    }
  }
);

app.get('/health', (_req, res) => res.json({ ok: true, t: Date.now(), provider: AI_PROVIDER, fb: FB_ENABLED }));

app.listen(PORT, () => {
  console.log(`[SalesBot] port=${PORT} provider=${AI_PROVIDER} model=${AI_PROVIDER === 'openrouter' ? OPENROUTER_MODEL : GEMINI_MODEL} fb=${FB_ENABLED}`);
  if (!LINE_SECRET || !LINE_TOKEN) console.warn('[SalesBot] LINE credentials missing');
  if (AI_PROVIDER === 'openrouter' && !OPENROUTER_KEY) console.warn('[SalesBot] OPENROUTER_API_KEY missing');
  if (AI_PROVIDER === 'gemini' && !GEMINI_KEY) console.warn('[SalesBot] GEMINI_API_KEY missing');
  if (!OWNER_USER_ID) console.warn('[SalesBot] OWNER_USER_ID missing — escalation disabled');
});
