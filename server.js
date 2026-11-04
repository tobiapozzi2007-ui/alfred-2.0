import dotenv from 'dotenv';
dotenv.config();

import TelegramBot from 'node-telegram-bot-api';
import { handleUserMessage } from './utils/ai.js';

const token = process.env.TELEGRAM_BOT_TOKEN;
const allowedId = process.env.ALLOWED_USER_ID;

if (!token) {
  console.error("❌ ERRORE: TELEGRAM_BOT_TOKEN mancante nel file .env!");
  process.exit(1);
}

// Inizializza il bot in modalità Long Polling (nessuna porta da aprire sul NAS)
const bot = new TelegramBot(token, { polling: true });

console.log("🦇 Alfred 2.0 è online e in ascolto sul NAS Synology!");

// Ascolta i messaggi di Telegram
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from ? msg.from.id.toString() : '';

  // Controllo di sicurezza: risponde solo a te
  if (allowedId && userId !== allowedId) {
    console.log(`⚠️ Messaggio ignorato da utente non autorizzato: ${userId}`);
    return bot.sendMessage(chatId, "Accesso negato.");
  }

  // Passa il messaggio al cervello AI (Gemini 2.5 Flash)
  if (msg.text) {
    await handleUserMessage(bot, msg);
  }
});

// Evita che eventuali micro-interruzioni di rete facciano crashare il bot
bot.on('polling_error', (error) => {
  console.error("⚠️ Errore connessione Telegram:", error.message || error);
});
