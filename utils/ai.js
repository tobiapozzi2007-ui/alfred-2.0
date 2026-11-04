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
    const mod = await import(`../modules/${file}`);
    if (mod.tools) allTools.push(...mod.tools);
    if (mod.handlers) Object.assign(allHandlers, mod.handlers);
  }
}

export async function handleUserMessage(bot, msg) {
  const chatId = msg.chat.id;
  const userText = msg.text;

  bot.sendChatAction(chatId, 'typing');

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        messages: [
          {
            role: 'system',
            content: `Sei Alfred 2.0, l'assistente personale autonomo. Rispondi sempre in modo naturale, sintetico ed efficiente. Data attuale: ${new Date().toISOString()}`
          },
          { role: 'user', content: userText }
        ],
        tools: allTools.length > 0 ? allTools : undefined,
        tool_choice: 'auto'
      })
    });

    const data = await response.json();
    const message = data.choices[0].message;

    // Se l'IA decide di usare uno strumento (Function Calling)
    if (message.tool_calls && message.tool_calls.length > 0) {
      for (const call of message.tool_calls) {
        const fnName = call.function.name;
        const args = JSON.parse(call.function.arguments);

        if (allHandlers[fnName]) {
          const result = await allHandlers[fnName](args);
          // Invia il risultato dell'azione all'utente
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
