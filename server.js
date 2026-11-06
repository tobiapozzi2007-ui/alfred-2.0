import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import { initAI, startModules, askAlfred } from './utils/ai.js';
import { clearHistory, saveMessage } from './utils/db.js';

const { TELEGRAM_BOT_TOKEN, ALLOWED_USER_ID, OPENROUTER_API_KEY } = process.env;

if (!TELEGRAM_BOT_TOKEN || !ALLOWED_USER_ID || !OPENROUTER_API_KEY) {
  console.error('Mancano variabili nel .env: servono TELEGRAM_BOT_TOKEN, ALLOWED_USER_ID e OPENROUTER_API_KEY.');
  process.exit(1);
}

await initAI();

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// Elabora un messaggio alla volta, così la cronologia resta coerente
let queue = Promise.resolve();

function splitMessage(text, max = 4000) {
  const chunks = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max);
    if (cut <= 0) cut = max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

async function sendLong(chatId, text) {
  for (const chunk of splitMessage(text)) {
    await bot.sendMessage(chatId, chunk);
  }
}

// Messaggio iniziato da Alfred (promemoria, briefing, avvisi): lo invia e lo
// registra nella cronologia, così se rispondi "ok" o "spostalo" ha il contesto.
async function notify(text) {
  await sendLong(ALLOWED_USER_ID, text);
  saveMessage('assistant', text);
}

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text = msg.text.trim();

  if (text === '/start') {
    await bot.sendMessage(chatId, 'Buongiorno, sono Alfred. Come posso aiutarla?');
    return;
  }
  if (text === '/reset') {
    clearHistory();
    await bot.sendMessage(chatId, 'Conversazione azzerata. La memoria permanente è rimasta intatta.');
    return;
  }

  bot.sendChatAction(chatId, 'typing').catch(() => {});
  const typing = setInterval(() => bot.sendChatAction(chatId, 'typing').catch(() => {}), 4000);

  try {
    const reply = await askAlfred(text);
    await sendLong(chatId, reply);
  } catch (err) {
    console.error('[server] Errore:', err);
    await bot.sendMessage(chatId, 'Mi dispiace, ho avuto un problema tecnico. Riprova tra poco.');
  } finally {
    clearInterval(typing);
  }
}

bot.on('message', (msg) => {
  // Sicurezza: si risponde solo all'utente autorizzato
  if (String(msg.from?.id) !== String(ALLOWED_USER_ID)) return;

  if (!msg.text) {
    bot.sendMessage(msg.chat.id, 'Per ora capisco solo messaggi di testo.').catch(() => {});
    return;
  }

  queue = queue.then(() => handleMessage(msg)).catch((err) => console.error('[server] Coda:', err));
});

bot.on('polling_error', (err) => console.error('[telegram] polling_error:', err.code || '', err.message));

// Avvia le attività proprie dei moduli (promemoria, briefing, avvisi...)
await startModules({ chatId: ALLOWED_USER_ID, notify });

const shutdown = async () => {
  console.log('Arresto di Alfred...');
  try {
    await bot.stopPolling();
  } finally {
    process.exit(0);
  }
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log('Alfred 2.0 è in ascolto.');
