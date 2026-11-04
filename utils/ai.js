import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import { fileURLToPath, pathToFileURL } from 'url';
import {
  tools as coreTools,
  handlers as coreHandlers,
  saveMessage,
  getRecentMessages
} from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODULES_DIR = path.join(__dirname, '..', 'modules');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'google/gemini-2.5-flash';
const MAX_TOOL_ROUNDS = 8;
const REQUEST_TIMEOUT_MS = 90_000;
const MAX_TOOL_RESULT_CHARS = 30_000;
const TIMEZONE = process.env.BOT_TIMEZONE || 'Europe/Rome';

let registeredTools = [];
let registeredHandlers = {};
let initialized = false;

/* ------------------------------------------------------------------ */
/*  Caricamento dinamico dei moduli                                    */
/* ------------------------------------------------------------------ */

function normalizeTool(tool) {
  if (tool?.type === 'function' && tool.function?.name) return tool;
  if (tool?.name) {
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description || '',
        parameters: tool.parameters || tool.input_schema || { type: 'object', properties: {} }
      }
    };
  }
  return null;
}

function register(toolList, handlerMap, source) {
  if (!Array.isArray(toolList) || !handlerMap) return;
  for (const raw of toolList) {
    const tool = normalizeTool(raw);
    if (!tool) {
      console.warn(`[ai] Schema tool non valido in "${source}", ignorato.`);
      continue;
    }
    const name = tool.function.name;
    if (typeof handlerMap[name] !== 'function') {
      console.warn(`[ai] Tool "${name}" (${source}) senza handler, ignorato.`);
      continue;
    }
    if (registeredHandlers[name]) {
      console.warn(`[ai] Tool "${name}" duplicato (${source}), ignorato.`);
      continue;
    }
    registeredTools.push(tool);
    registeredHandlers[name] = handlerMap[name];
  }
}

export async function initAI() {
  registeredTools = [];
  registeredHandlers = {};

  // Memoria permanente (utils/db.js)
  register(coreTools, coreHandlers, 'utils/db.js');

  // Scansione automatica di modules/
  const files = fs
    .readdirSync(MODULES_DIR)
    .filter((f) => f.endsWith('.js'))
    .sort();

  for (const file of files) {
    try {
      const mod = await import(pathToFileURL(path.join(MODULES_DIR, file)).href);
      register(mod.tools, mod.handlers, `modules/${file}`);
      console.log(`[ai] Modulo caricato: ${file}`);
    } catch (err) {
      console.error(`[ai] Errore nel caricamento di ${file}:`, err.message);
    }
  }

  initialized = true;
  console.log(`[ai] ${registeredTools.length} tool disponibili.`);
}

/* ------------------------------------------------------------------ */
/*  Prompt di sistema (generico)                                       */
/* ------------------------------------------------------------------ */

function buildSystemPrompt() {
  const now = new Date().toLocaleString('it-IT', {
    timeZone: TIMEZONE,
    dateStyle: 'full',
    timeStyle: 'short'
  });

  return [
    'Sei Alfred, un assistente personale gentile, efficiente e di poche parole inutili. Rispondi sempre in italiano.',
    `Data e ora attuali (${TIMEZONE}): ${now}. Usala per interpretare riferimenti come "domani", "venerdì prossimo" o "stasera".`,
    'Hai a disposizione degli strumenti: usali ogni volta che servono dati aggiornati o azioni concrete, senza chiedere conferma per semplici letture. Per azioni con effetti esterni (inviare messaggi, creare eventi) assicurati di avere tutti i dati necessari e, se manca qualcosa di essenziale, chiedilo.',
    'Dopo aver ricevuto il risultato di uno strumento, rileggi i dati e scrivi una risposta finale naturale, discorsiva e dettagliata. Non mostrare mai JSON, nomi di funzioni o dati grezzi all\'utente.',
    'Se uno strumento restituisce un errore, spiegalo in modo semplice e proponi come procedere.',
    'Formato: testo semplice adatto a Telegram, senza Markdown (niente asterischi, cancelletti o backtick). Puoi andare a capo e usare qualche emoji con parsimonia.'
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/*  Chiamata a OpenRouter                                              */
/* ------------------------------------------------------------------ */

async function callModel(messages, { allowTools = true } = {}) {
  const body = { model: MODEL, messages, temperature: 0.4 };
  if (allowTools && registeredTools.length) {
    body.tools = registeredTools;
    body.tool_choice = 'auto';
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'X-Title': 'Alfred 2.0'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    const raw = await res.text();
    if (!res.ok) {
      throw new Error(`OpenRouter ${res.status}: ${raw.slice(0, 500)}`);
    }

    const data = JSON.parse(raw);
    const message = data.choices?.[0]?.message;
    if (!message) {
      throw new Error(`Risposta OpenRouter inattesa: ${raw.slice(0, 500)}`);
    }
    return message;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/*  Esecuzione dei tool                                                */
/* ------------------------------------------------------------------ */

async function runTool(call) {
  const name = call.function?.name;
  const handler = registeredHandlers[name];

  if (!handler) return { error: `Strumento "${name}" non disponibile.` };

  let args = {};
  try {
    const rawArgs = call.function?.arguments;
    args = rawArgs && rawArgs.trim() ? JSON.parse(rawArgs) : {};
  } catch {
    return { error: 'Argomenti non validi (JSON non interpretabile).' };
  }

  try {
    console.log(`[ai] Tool: ${name}`, JSON.stringify(args));
    const result = await handler(args);
    return result === undefined ? { success: true } : result;
  } catch (err) {
    console.error(`[ai] Errore nel tool ${name}:`, err);
    return { error: err.message || String(err) };
  }
}

function serializeToolResult(result) {
  let text;
  try {
    text = typeof result === 'string' ? result : JSON.stringify(result);
  } catch {
    text = String(result);
  }
  return text.length > MAX_TOOL_RESULT_CHARS
    ? text.slice(0, MAX_TOOL_RESULT_CHARS) + '...[troncato]'
    : text;
}

/* ------------------------------------------------------------------ */
/*  Ciclo principale                                                   */
/* ------------------------------------------------------------------ */

export async function askAlfred(userText) {
  if (!initialized) await initAI();

  const messages = [
    { role: 'system', content: buildSystemPrompt() },
    ...getRecentMessages(10),
    { role: 'user', content: userText }
  ];

  let finalText = null;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const message = await callModel(messages);
    const toolCalls = message.tool_calls;

    if (!toolCalls || toolCalls.length === 0) {
      finalText = message.content;
      break;
    }

    // Fase 1: l'assistente chiede i tool
    messages.push({
      role: 'assistant',
      content: message.content || '',
      tool_calls: toolCalls
    });

    // Fase 2: i risultati rientrano in Gemini (role: 'tool')
    for (const call of toolCalls) {
      const result = await runTool(call);
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: serializeToolResult(result)
      });
    }
  }

  // Se il limite di giri è esaurito, forza una risposta finale senza tool
  if (finalText === null) {
    const message = await callModel(messages, { allowTools: false });
    finalText = message.content;
  }

  finalText = (finalText || '').trim() || 'Scusa, non sono riuscito a formulare una risposta. Riprova pure.';

  saveMessage('user', userText);
  saveMessage('assistant', finalText);

  return finalText;
}
