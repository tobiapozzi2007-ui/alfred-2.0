import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import { dbTools, dbHandlers, saveChatMessage, getRecentHistory } from './db.js';

let allTools = [...dbTools];
let allHandlers = { ...dbHandlers };

const modulesPath = path.resolve('modules');
if (fs.existsSync(modulesPath)) {
  const files = fs.readdirSync(modulesPath).filter(f => f.endsWith('.js'));
  for (const file of files) {
    try {
      const mod = await import(`../modules/${file}`);
      if (mod.tools) allTools.push(...mod.tools);
      if (mod.handlers) Object.assign(allHandlers, mod.handlers);
    } catch (e) {
      console.error(`Errore caricamento modulo ${file}:`, e.message);
    }
  }
}

export async function handleUserMessage(bot, msg) {
  const chatId = msg.chat.id;
  const userText = msg.text;

  bot.sendChatAction(chatId, 'typing');

  // 1. Registra il messaggio utente nella cronologia locale
  saveChatMessage(chatId, 'user', userText);

  // 2. Recupera fino agli ultimi 10 messaggi scambiati per dare contesto a Gemini
  const conversationHistory = getRecentHistory(chatId, 10);

  try {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) return bot.sendMessage(chatId, "❌ Errore: OPENROUTER_API_KEY non trovata nel file .env!");

    const systemPrompt = {
      role: 'system',
      content: `Sei Alfred 2.0, un assistente personale autonomo ed efficiente.
Data e ora corrente: ${new Date().toLocaleString('it-IT')}.

REGOLE SULLA MEMORIA:
1. Quando l'utente ti comunica una preferenza o dato personale (es. la sua email, nome o note importanti), invoca SUBITO il tool 'save_to_memory' usando come collezione 'profilo' o 'note'.
2. Se ti viene chiesta un'informazione memorizzata in precedenza che non ricordi, usa 'read_memory' per cercarla.`
    };

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        messages: [systemPrompt, ...conversationHistory],
        tools: allTools.length > 0 ? allTools : undefined,
        tool_choice: 'auto'
      })
    });

    const data = await response.json();

    if (data.error) {
      return bot.sendMessage(chatId, `❌ Errore OpenRouter: ${data.error.message}`);
    }

    if (!data.choices || !data.choices[0]) {
      return bot.sendMessage(chatId, "⚠️ Nessuna risposta ricevuta dal modello AI.");
    }

    const message = data.choices[0].message;

    // Gestione chiamate ai moduli/funzioni
    if (message.tool_calls && message.tool_calls.length > 0) {
      for (const call of message.tool_calls) {
        const fnName = call.function.name;
        const args = JSON.parse(call.function.arguments);

        if (allHandlers[fnName]) {
          const result = await allHandlers[fnName](args);
          saveChatMessage(chatId, 'assistant', result);
          await bot.sendMessage(chatId, result);
        }
      }
    } else if (message.content) {
      saveChatMessage(chatId, 'assistant', message.content);
      await bot.sendMessage(chatId, message.content);
    }
  } catch (err) {
    console.error("Errore AI:", err);
    bot.sendMessage(chatId, "Si è verificato un errore durante l'elaborazione della richiesta.");
  }
}
