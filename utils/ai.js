import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import { dbTools, dbHandlers } from './db.js';

let allTools = [...dbTools];
let allHandlers = { ...dbHandlers };

// CARICAMENTO AUTOMATICO DEI MODULI PLUG-AND-PLAY
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

  try {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      await bot.sendMessage(chatId, "❌ Errore: OPENROUTER_API_KEY non trovata nel file .env!");
      return;
    }

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        messages: [
          {
            role: 'system',
            content: `Sei Alfred 2.0, l'assistente personale autonomo. Rispondi sempre in modo naturale, sintetico ed efficiente in italiano. Data e ora attuale: ${new Date().toLocaleString('it-IT')}`
          },
          { role: 'user', content: userText }
        ],
        tools: allTools.length > 0 ? allTools : undefined,
        tool_choice: 'auto'
      })
    });

    const data = await response.json();

    // Gestione errori API OpenRouter
    if (data.error) {
      console.error("❌ Errore OpenRouter:", JSON.stringify(data.error));
      await bot.sendMessage(chatId, `❌ Errore OpenRouter: ${data.error.message || 'Verifica la tua chiave API o il saldo.'}`);
      return;
    }

    if (!data.choices || !data.choices[0]) {
      console.error("❌ Risposta OpenRouter non valida:", JSON.stringify(data));
      await bot.sendMessage(chatId, "⚠️ Nessuna risposta ricevuta dal modello AI.");
      return;
    }

    const message = data.choices[0].message;

    // Se l'IA attiva una funzione (Function Calling)
    if (message.tool_calls && message.tool_calls.length > 0) {
      for (const call of message.tool_calls) {
        const fnName = call.function.name;
        const args = JSON.parse(call.function.arguments);

        if (allHandlers[fnName]) {
          const result = await allHandlers[fnName](args);
          await bot.sendMessage(chatId, result);
        }
      }
    } else if (message.content) {
      await bot.sendMessage(chatId, message.content);
    }
  } catch (err) {
    console.error("Errore AI:", err);
    bot.sendMessage(chatId, "Si è verificato un errore durante l'elaborazione della richiesta.");
  }
}
