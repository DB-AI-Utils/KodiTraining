import TelegramBot from 'node-telegram-bot-api';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

let bot = null;
let callbackHandler = null;

export function isConfigured() {
  return !!(BOT_TOKEN && CHAT_ID);
}

export function init() {
  if (!isConfigured()) return;

  bot = new TelegramBot(BOT_TOKEN, { polling: true });

  bot.on('callback_query', async (query) => {
    if (callbackHandler) {
      try {
        await callbackHandler(query);
      } catch (err) {
        console.error('[telegram] Callback handler error:', err.message);
      }
    }
    try {
      await bot.answerCallbackQuery(query.id);
    } catch {
      // ignore if already answered
    }
  });

  bot.on('polling_error', (err) => {
    console.error('[telegram] Polling error:', err.message);
  });

  console.log('[telegram] Bot initialized in polling mode');
}

export function onCallback(handler) {
  callbackHandler = handler;
}

export async function sendSessionPrompt(sessionInfo) {
  if (!bot) return null;

  const { date, timeRange, cameraA, cameraB } = sessionInfo;

  const text = [
    `🎬 *Training Session Recorded*`,
    ``,
    `📅 ${date}, ${timeRange}`,
    `📹 Camera A: ${cameraA.segments} segments, ${cameraA.duration}, ${cameraA.size}`,
    `📹 Camera B: ${cameraB.segments} segments, ${cameraB.duration}, ${cameraB.size}`,
    ``,
    `Process with default settings?`,
  ].join('\n');

  const msg = await bot.sendMessage(CHAT_ID, text, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Yes', callback_data: `approve:${sessionInfo.sessionId}` },
        { text: '❌ No', callback_data: `reject:${sessionInfo.sessionId}` },
      ]],
    },
  });

  return msg;
}

export async function sendProgress(messageId, text) {
  if (!bot) return;

  try {
    await bot.editMessageText(text, {
      chat_id: CHAT_ID,
      message_id: messageId,
      parse_mode: 'Markdown',
    });
  } catch {
    // message might not have changed
  }
}

export async function sendCompletion(messageId, { duration, size, downloadUrl, sessionId }) {
  if (!bot) return;

  const text = [
    `✅ *Processing Complete*`,
    ``,
    `⏱ Duration: ${duration}`,
    `💾 Size: ${size}`,
    ``,
    `📥 Download (expires in 1 hour):`,
    downloadUrl,
  ].join('\n');

  await bot.editMessageText(text, {
    chat_id: CHAT_ID,
    message_id: messageId,
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[
        { text: '🗑 Delete source files', callback_data: `delete:${sessionId}` },
        { text: '🔄 New download link', callback_data: `newlink:${sessionId}` },
      ]],
    },
  });
}

export async function sendError(messageId, errorMessage) {
  if (!bot) return;

  const text = [
    `❌ *Processing Failed*`,
    ``,
    errorMessage,
    ``,
    `Files remain on Pi — process manually via web UI.`,
  ].join('\n');

  if (messageId) {
    try {
      await bot.editMessageText(text, {
        chat_id: CHAT_ID,
        message_id: messageId,
        parse_mode: 'Markdown',
      });
      return;
    } catch {
      // fallback to new message
    }
  }

  await bot.sendMessage(CHAT_ID, text, { parse_mode: 'Markdown' });
}

export async function editMessage(messageId, text, replyMarkup) {
  if (!bot) return;

  const opts = {
    chat_id: CHAT_ID,
    message_id: messageId,
    parse_mode: 'Markdown',
  };
  if (replyMarkup) opts.reply_markup = replyMarkup;

  try {
    await bot.editMessageText(text, opts);
  } catch {
    // message might not have changed
  }
}

export async function sendMessage(text) {
  if (!bot) return null;
  return bot.sendMessage(CHAT_ID, text, { parse_mode: 'Markdown' });
}
