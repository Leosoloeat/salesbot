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

// In-memory conversation history per user (last 10 turns)
const history = new Map();

function getHistory(userId) {
  if (!history.has(userId)) history.set(userId, []);
  return history.get(userId);
}

function pushHistory(userId, role, text) {
  const h = getHistory(userId);
  h.push({ role, parts: [{ text }] });
  if (h.length > 20) h.splice(0, 2); // keep last 10 turns (20 entries)
}

function loadSystemPrompt() {
  try {
    return fs.readFileSync(path.join(__dirname, 'prompts/system.md'), 'utf8');
  } catch {
    return 'คุณคือ SalesBot ผู้ช่วยขายอัตโนมัติของ Leo Ai';
  }
}

function verifySignature(rawBody, signature) {
  const hash = crypto
    .createHmac('sha256', LINE_SECRET)
    .update(rawBody)
    .digest('base64');
  return hash === signature;
}

async function generateReply(userId, userText) {
  const genAI = new GoogleGenerativeAI(GEMINI_KEY);
  const model = genAI.getGenerativeModel({
    model: GEMINI_MODEL,
    systemInstruction: loadSystemPrompt(),
  });

  const userHistory = getHistory(userId);

  const chat = model.startChat({ history: userHistory });
  const result = await chat.sendMessage(userText);
  const reply = result.response.text().trim();

  pushHistory(userId, 'user', userText);
  pushHistory(userId, 'model', reply);

  return reply;
}

async function replyToLine(replyToken, text) {
  const client = new line.messagingApi.MessagingApiClient({
    channelAccessToken: LINE_TOKEN,
  });
  await client.replyMessage({
    replyToken,
    messages: [{ type: 'text', text }],
  });
}

const app = express();

// Webhook — raw body required for signature verification
app.post('/webhook', express.raw({ type: '*/*', limit: '2mb' }), async (req, res) => {
  if (!LINE_SECRET || !LINE_TOKEN || !GEMINI_KEY) {
    console.error('[webhook] missing env vars');
    return res.status(200).send('not configured');
  }

  let body;
  try {
    body = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.status(400).send('bad json');
  }

  // LINE verify check sends empty events array — return 200 immediately
  const events = Array.isArray(body.events) ? body.events : [];
  if (events.length === 0) {
    return res.status(200).send('ok');
  }

  // Verify signature for real events
  const signature = req.get('x-line-signature') || '';
  const sigOk = verifySignature(req.body, signature);
  console.log('[webhook] sig_ok=%s secret_len=%d', sigOk, LINE_SECRET.length);
  if (!sigOk) {
    console.warn('[webhook] bad signature — continuing anyway for debug');
  }

  // Acknowledge LINE immediately
  res.status(200).send('ok');

  for (const event of events) {
    if (event.type !== 'message' || event.message?.type !== 'text') continue;

    const userId = event.source?.userId || 'unknown';
    const userText = event.message.text || '';
    const replyToken = event.replyToken;

    console.log(`[webhook] user=${userId} text="${userText}"`);

    try {
      console.log(`[webhook] calling Gemini for user=${userId}`);
      const reply = await generateReply(userId, userText);
      console.log(`[webhook] Gemini reply="${reply.slice(0,50)}"`);
      await replyToLine(replyToken, reply);
      console.log(`[webhook] LINE reply sent to ${userId}`);
    } catch (err) {
      console.error('[webhook] error:', err.message, err.stack?.split('\n')[1]);
      try {
        await replyToLine(replyToken, 'ขออภัยครับ ระบบขัดข้องชั่วคราว กรุณาลองใหม่อีกสักครู่นะครับ');
      } catch {}
    }
  }
});

app.get('/health', (_req, res) => res.json({ ok: true, t: Date.now() }));

app.listen(PORT, () => {
  console.log(`[SalesBot] listening on port ${PORT}`);
  console.log(`[SalesBot] webhook: POST /webhook`);
  if (!LINE_SECRET || !LINE_TOKEN) console.warn('[SalesBot] WARNING: LINE credentials missing');
  if (!GEMINI_KEY) console.warn('[SalesBot] WARNING: GEMINI_API_KEY missing');
});
