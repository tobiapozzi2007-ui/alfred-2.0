import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import { dbTools, dbHandlers, saveChatMessage, getRecentHistory } from './db.js';

let allTools = [...dbTools];
let allHandlers = { ...dbHandlers };

// Caricamento dinamico ed automatico dei moduli Plug-and-Play
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

console.log("🛠️ Moduli e strumenti caricati dinamicamente:");
allTools.forEach(t => console.log(`   👉 ${t.function.name}`));

export async function handleUserMessage(bot, msg) {
  const chatId = msg.chat.id;
  const userText = msg.text;

  bot.sendChatAction(chatId, 'typing');
  saveChatMessage(chatId, 'user', userText);

  const conversationHistory = getRecentHistory(chatId, 10);

  try {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) return bot.sendMessage(chatId, "❌ Errore: OPENROUTER_API_KEY non trovata nel file .env!");

    // Prompt di sistema completamente generico: NESSUNA funzione cablata!
    const systemPrompt = {
      role: 'system',
      content: `Sei Alfred 2.0, un assistente personale autonomo, intelligente ed efficiente.
Data e ora corrente: ${new Date().toLocaleString('it-IT')}.

ISTRUZIONI GENERATIVE ED ESECUZIONE TOOL:
1. Hai a disposizione strumenti (tools) per accedere a dati esterni, memoria locale o servizi. Usali autonomamente ogni volta che serve per soddisfare la richiesta.
2. Quando ricevi l'esito o i dati da uno strumento, NON mostrare mai il JSON o il testo grezzo all'utente.
3. Rileggi i dati ottenuti e formula una risposta chiara, naturale, discorsiva, precisa ed esaustiva in italiano in base alla domanda esatta dell'utente.`
    };

    let messages = [systemPrompt, ...conversationHistory];

    // Ciclo dinamico di rielaborazione (Tool Call -> Esecuzione -> Risposta finale)
    let maxTurns = 5;
    while (maxTurns > 0) {
      maxTurns--;

      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'google/gemini-2.5-flash',
          messages: messages,
          tools: allTools.length > 0 ? allTools : undefined,
          tool_choice: 'auto'
        })
      });

      const data = await response.json();

      if (data.error) {
        console.error("❌ Errore OpenRouter:", data.error);
        return bot.sendMessage(chatId, `❌ Errore OpenRouter: ${data.error.message}`);
      }

      if (!data.choices || !data.choices[0]) {
        return bot.sendMessage(chatId, "⚠️ Nessuna risposta ricevuta dal modello AI.");
      }

      const responseMessage = data.choices[0].message;
      messages.push(responseMessage);

      // Risposta finale rielaborata per l'utente
      if (!responseMessage.tool_calls || responseMessage.tool_calls.length === 0) {
        const finalReply = responseMessage.content || "Richiesta completata.";
        saveChatMessage(chatId, 'assistant', finalReply);
        await bot.sendMessage(chatId, finalReply);
        break;
      }

      // Esecuzione dei tool invocati dall'IA in autonomia
      for (const call of responseMessage.tool_calls) {
        const fnName = call.function.name;
        let args = {};
        try {
          args = JSON.parse(call.function.arguments);
        } catch (e) {
          args = {};
        }

        console.log(`⚙️ Esecuzione tool '${fnName}':`, args);

        let toolResult = "Funzione non trovata o fallita.";
        if (allHandlers[fnName]) {
          try {
            toolResult = await allHandlers[fnName](args);
          } catch (err) {
            toolResult = `Errore esecuzione ${fnName}: ${err.message}`;
          }
        }

        // Passiamo i dati grezzi ottenuti dal modulo a Gemini affinché li rilegga e risponda
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: fnName,
          content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult)
        });
      }
    }
  } catch (err) {
    console.error("Errore AI:", err);
    bot.sendMessage(chatId, "Si è verificato un errore durante l'elaborazione della richiesta.");
  }
}
