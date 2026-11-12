import 'dotenv/config';
import fetch from 'node-fetch';
import TelegramBot from 'node-telegram-bot-api';
import { initAI, startModules, askAlfred, runTask, getToolCatalog } from './utils/ai.js';
import { announceUpdate } from './utils/updates.js';
import { handleCommand, COMMAND_LIST } from './utils/commands.js';
import { clearHistory, saveMessage } from './utils/db.js';

const { TELEGRAM_BOT_TOKEN, ALLOWED_USER_ID, OPENROUTER_API_KEY } = process.env;

if (!TELEGRAM_BOT_TOKEN || !ALLOWED_USER_ID || !OPENROUTER_API_KEY) {
  console.error('Mancano variabili nel .env: servono TELEGRAM_BOT_TOKEN, ALLOWED_USER_ID e OPENROUTER_API_KEY.');
  process.exit(1);
}

await initAI();

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// Il menù che compare quando scrivi "/" nella chat, così non serve ricordare i comandi
bot
  .setMyCommands(COMMAND_LIST.map(({ command, description }) => ({ command, description })))
  .catch((err) => console.error('[telegram] Menù dei comandi non impostato:', err.message));

const MAX_FILE_BYTES = 15 * 1024 * 1024;
const DEFAULT_ATTACHMENT_PROMPT =
  'Ti ho inviato questo allegato: dimmi cosa contiene e, se ha senso, fai ciò che serve (per esempio registra la spesa se è uno scontrino).';

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

/* ------------------------------------------------------------------ */
/*  Allegati: foto e PDF                                               */
/* ------------------------------------------------------------------ */

async function downloadAsBase64(fileId) {
  const link = await bot.getFileLink(fileId);
  const res = await fetch(link);
  if (!res.ok) throw new Error(`Download fallito (${res.status})`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_FILE_BYTES) throw new Error('FILE_TROPPO_GRANDE');
  return buffer.toString('base64');
}

// Restituisce l'elenco di allegati leggibili, oppure lancia un errore comprensibile
async function collectAttachments(msg) {
  if (msg.photo?.length) {
    const best = msg.photo[msg.photo.length - 1]; // la risoluzione più alta
    return [{ type: 'image', mime: 'image/jpeg', data: await downloadAsBase64(best.file_id) }];
  }

  const doc = msg.document;
  if (!doc) return [];
  if (doc.file_size && doc.file_size > MAX_FILE_BYTES) throw new Error('FILE_TROPPO_GRANDE');

  const mime = doc.mime_type || '';
  if (mime === 'application/pdf') {
    return [{ type: 'pdf', filename: doc.file_name || 'documento.pdf', data: await downloadAsBase64(doc.file_id) }];
  }
  if (mime.startsWith('image/')) {
    return [{ type: 'image', mime, data: await downloadAsBase64(doc.file_id) }];
  }
  throw new Error('FORMATO_NON_SUPPORTATO');
}

/* ------------------------------------------------------------------ */
/*  Gestione messaggi                                                  */
/* ------------------------------------------------------------------ */

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text = (msg.text || msg.caption || '').trim();

  if (msg.text) {
    if (text === '/start') {
      await bot.sendMessage(chatId, 'Buongiorno, sono Alfred. Come posso aiutarla?');
      return;
    }
    if (text === '/reset') {
      clearHistory();
      await bot.sendMessage(chatId, 'Conversazione azzerata. La memoria permanente è rimasta intatta.');
      return;
    }

    // Comandi che non passano dall'IA (/stato, /memoria, /regola, /aggiorna...)
    if (text.startsWith('/')) {
      try {
        const reply = await handleCommand(text, { toolCount: getToolCatalog().length });
        if (reply !== null) {
          await sendLong(chatId, reply);
          return;
        }
      } catch (err) {
        console.error('[server] Errore nel comando:', err);
        await bot.sendMessage(chatId, `Il comando non è riuscito: ${err.message}`);
        return;
      }
    }
  }

  bot.sendChatAction(chatId, 'typing').catch(() => {});
  const typing = setInterval(() => bot.sendChatAction(chatId, 'typing').catch(() => {}), 4000);

  try {
    let attachments = [];
    try {
      attachments = await collectAttachments(msg);
    } catch (err) {
      if (err.message === 'FILE_TROPPO_GRANDE') {
        await bot.sendMessage(chatId, 'Il file è troppo grande: il limite è 15 MB.');
      } else if (err.message === 'FORMATO_NON_SUPPORTATO') {
        await bot.sendMessage(chatId, 'Per ora leggo solo foto, immagini e PDF.');
      } else {
        console.error('[server] Errore nel download dell\'allegato:', err.message);
        await bot.sendMessage(chatId, 'Non sono riuscito a scaricare l\'allegato. Riprova tra poco.');
      }
      return;
    }

    const prompt = text || DEFAULT_ATTACHMENT_PROMPT;
    const reply = await askAlfred(prompt, attachments);
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

  if (!msg.text && !msg.photo && !msg.document) {
    bot.sendMessage(msg.chat.id, 'Per ora capisco messaggi di testo, foto e PDF.').catch(() => {});
    return;
  }

  queue = queue.then(() => handleMessage(msg)).catch((err) => console.error('[server] Coda:', err));
});

bot.on('polling_error', (err) => console.error('[telegram] polling_error:', err.code || '', err.message));

// Avvia le attività proprie dei moduli (promemoria, briefing, email, backup...)
await startModules({ chatId: ALLOWED_USER_ID, notify });

// Dopo un aggiornamento scrive all'utente cosa è cambiato e quali nuove skill ha imparato
announceUpdate({ catalog: getToolCatalog(), notify, runTask }).catch((err) =>
  console.error('[server] Annuncio aggiornamento non riuscito:', err.message)
);

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
