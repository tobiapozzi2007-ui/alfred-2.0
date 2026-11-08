import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import { fileURLToPath, pathToFileURL } from 'url';
import * as dbModule from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODULES_DIR = path.join(__dirname, '..', 'modules');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash';
const MAX_TOOL_ROUNDS = 8;
const REQUEST_TIMEOUT_MS = 90_000;
const MAX_TOOL_RESULT_CHARS = 30_000;
const TIMEZONE = process.env.BOT_TIMEZONE || 'Europe/Rome';
// Quanti messaggi recenti rileggere a ogni richiesta (modificabile con HISTORY_LIMIT nel .env)
const HISTORY_LIMIT = Math.min(Math.max(parseInt(process.env.HISTORY_LIMIT, 10) || 30, 4), 100);

let registeredTools = [];
let registeredHandlers = {};
let toolSource = {};
let initHooks = [];
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
    toolSource[name] = source;
  }
}

export async function initAI() {
  registeredTools = [];
  registeredHandlers = {};
  toolSource = {};
  initHooks = [];

  // Memoria permanente (utils/db.js): accetta sia tools/handlers sia dbTools/dbHandlers
  register(dbModule.tools ?? dbModule.dbTools, dbModule.handlers ?? dbModule.dbHandlers, 'utils/db.js');

  // Scansione automatica di modules/
  const files = fs
    .readdirSync(MODULES_DIR)
    .filter((f) => f.endsWith('.js'))
    .sort();

  for (const file of files) {
    try {
      const mod = await import(pathToFileURL(path.join(MODULES_DIR, file)).href);
      register(mod.tools, mod.handlers, `modules/${file}`);
      // Hook opzionale: un modulo può esportare init(ctx) per avviare attività proprie (timer, controlli periodici)
      if (typeof mod.init === 'function') initHooks.push({ file, init: mod.init });
      console.log(`[ai] Modulo caricato: ${file}`);
    } catch (err) {
      console.error(`[ai] Errore nel caricamento di ${file}:`, err.message);
    }
  }

  initialized = true;
  console.log(`[ai] ${registeredTools.length} tool disponibili.`);
}

// Elenco delle capacità caricate (serve ad annunciare le nuove skill dopo un aggiornamento)
export function getToolCatalog() {
  return registeredTools.map((t) => {
    const source = toolSource[t.function.name] || '';
    const module = source.startsWith('utils/') ? 'memoria' : source.replace(/^modules\//, '').replace(/\.js$/, '');
    return { name: t.function.name, description: t.function.description || '', module };
  });
}

/**
 * Avvia gli hook init(ctx) dei moduli che ne hanno uno.
 * ctx contiene: chatId, notify(testo), runTask(istruzione).
 * Va chiamata una sola volta, dopo che il bot Telegram è pronto.
 */
export async function startModules(baseCtx) {
  if (!initialized) await initAI();
  const ctx = { ...baseCtx, runTask };
  for (const hook of initHooks) {
    try {
      await hook.init(ctx);
      console.log(`[ai] Attività avviate: ${hook.file}`);
    } catch (err) {
      console.error(`[ai] Errore in init di ${hook.file}:`, err);
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Prompt di sistema (generico)                                       */
/* ------------------------------------------------------------------ */

function buildSystemPrompt(queryText = '') {
  const now = new Date().toLocaleString('it-IT', {
    timeZone: TIMEZONE,
    dateStyle: 'full',
    timeStyle: 'short'
  });

  const base = [
    'Sei Alfred, un assistente personale gentile, efficiente e di poche parole inutili. Rispondi sempre in italiano.',
    `Data e ora attuali (${TIMEZONE}): ${now}. Usala per interpretare riferimenti come "domani", "venerdì prossimo" o "stasera".`,
    'Hai a disposizione degli strumenti: usali ogni volta che servono dati aggiornati o azioni concrete, senza chiedere conferma per semplici letture. Per azioni con effetti esterni (inviare messaggi, creare eventi) assicurati di avere tutti i dati necessari e, se manca qualcosa di essenziale, chiedilo.',
    'Dopo aver ricevuto il risultato di uno strumento, rileggi i dati e scrivi una risposta finale naturale, discorsiva e dettagliata. Non mostrare mai JSON, nomi di funzioni o dati grezzi all\'utente.',
    'Se uno strumento restituisce un errore, spiegalo in modo semplice e proponi come procedere.',
    'Memoria: quando l\'utente ti dà un\'informazione da ricordare, una preferenza o una regola, salvala subito con lo strumento di memoria, senza chiedere conferma. Frasi come "devi sempre", "d\'ora in poi", "ricordati che" o "come regola" indicano una regola o preferenza permanente: salvala subito, prima di rispondere. Regole, preferenze e istruzioni permanenti vanno salvate come "sempre visibili"; fatti e dati (contatti, date, indirizzi) come ricordi normali, in uno spazio di memoria coerente con quelli già esistenti. Scrivi le voci in terza persona ("L\'utente si chiama..."), mai in prima persona. Se una nuova informazione corregge o integra qualcosa di già salvato, aggiornala invece di crearne un\'altra. Se ciò che serve non compare nella memoria che ti viene mostrata, cercalo con lo strumento di lettura prima di dire che non lo sai o che non ricordi. Dì di aver salvato qualcosa solo se lo strumento ha avuto successo.',
    'Formato: testo semplice adatto a Telegram, senza Markdown (niente asterischi, cancelletti o backtick). Puoi andare a capo e usare qualche emoji con parsimonia.'
  ].join('\n');

  let memory = '';
  try {
    memory = dbModule.getMemoryContext?.(queryText) || '';
  } catch (err) {
    console.error('[ai] Contesto di memoria non disponibile:', err.message);
  }
  return memory ? `${base}\n\n${memory}` : base;
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

  // Motore di lettura PDF opzionale (es. pdf-text o mistral-ocr), solo se c'è un PDF nella conversazione
  const hasPdf = messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'file'));
  if (hasPdf && process.env.OPENROUTER_PDF_ENGINE) {
    body.plugins = [{ id: 'file-parser', pdf: { engine: process.env.OPENROUTER_PDF_ENGINE } }];
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
/*  Ciclo Function Calling a due fasi                                  */
/* ------------------------------------------------------------------ */

// Il modello a volte scrive "ho salvato / ho inviato..." senza aver chiamato nessuno strumento.
const ACTION_CLAIM =
  /\b(ho|abbiamo)\s+(appena\s+)?(salvat[oa]|memorizzat[oa]|registrat[oa]|annotat[oa]|aggiunt[oa]|inviat[oa]|mandat[oa]|creat[oa]|eliminat[oa]|cancellat[oa]|aggiornat[oa]|impostat[oa]|programmat[oa])\b|(?:^|\s)(è|e'|sono)\s+stat[oaie]\s+(salvat|memorizzat|registrat|inviat|aggiunt|creat|eliminat|aggiornat)|d['’]ora\s+in\s+poi|da\s+ora\s+in\s+poi|la\s+prossima\s+volta|\bricorder[òo]|\bterr[òo]\s+(a\s+mente|presente|conto)/i;

export const claimsAction = (text) => ACTION_CLAIM.test(String(text || ''));

async function runLoop(messages) {
  let finalText = null;
  let toolsUsed = 0;
  let guardUsed = false;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const message = await callModel(messages);
    const toolCalls = message.tool_calls;

    if (!toolCalls || toolCalls.length === 0) {
      // Dichiara un'azione ma non ha usato strumenti: gli si chiede di verificare, una sola volta
      if (!toolsUsed && !guardUsed && claimsAction(message.content)) {
        guardUsed = true;
        console.warn('[ai] La risposta dichiara un\'azione ma nessuno strumento è stato usato: chiedo di verificare.');
        messages.push({ role: 'assistant', content: message.content });
        messages.push({
          role: 'user',
          content:
            '[CONTROLLO AUTOMATICO, non è un messaggio dell\'utente] Nella tua risposta dichiari di aver eseguito un\'azione o prometti qualcosa per il futuro (salvare, inviare, ricordare, "d\'ora in poi..."), ma in questo turno non hai usato nessuno strumento. Se si tratta di una regola, preferenza o informazione che l\'utente vuole che tu ricordi, salvala adesso con lo strumento di memoria (regole e preferenze come sempre visibili). Se l\'azione richiede un altro strumento, chiamalo adesso. Se invece non serviva o non l\'hai fatta, riscrivi la risposta senza affermare cose che non hai fatto.'
        });
        continue;
      }
      finalText = message.content;
      break;
    }

    toolsUsed += toolCalls.length;

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

  return (finalText || '').trim();
}

/* ------------------------------------------------------------------ */
/*  API pubbliche                                                      */
/* ------------------------------------------------------------------ */

function buildUserContent(text, attachments) {
  const parts = [{ type: 'text', text }];
  for (const a of attachments) {
    if (a.type === 'image') {
      parts.push({ type: 'image_url', image_url: { url: `data:${a.mime};base64,${a.data}` } });
    } else if (a.type === 'pdf') {
      parts.push({
        type: 'file',
        file: { filename: a.filename || 'documento.pdf', file_data: `data:application/pdf;base64,${a.data}` }
      });
    }
  }
  return parts;
}

// Messaggio dell'utente (con eventuali foto o PDF) -> risposta; salva lo scambio nella cronologia
export async function askAlfred(userText, attachments = []) {
  if (!initialized) await initAI();

  const history = dbModule.getRecentMessages(HISTORY_LIMIT);
  const previousUser = [...history].reverse().find((m) => m.role === 'user')?.content || '';

  const messages = [
    { role: 'system', content: buildSystemPrompt(`${userText}\n${previousUser}`) },
    ...history,
    { role: 'user', content: attachments.length ? buildUserContent(userText, attachments) : userText }
  ];

  const finalText =
    (await runLoop(messages)) || 'Scusa, non sono riuscito a formulare una risposta. Riprova pure.';

  // In cronologia resta solo il testo (gli allegati non vengono conservati)
  dbModule.saveMessage('user', attachments.length ? `${userText}\n[allegati inviati: ${attachments.length}]` : userText);
  dbModule.saveMessage('assistant', finalText);

  return finalText;
}

// Compito automatico (promemoria, briefing, avvisi...) -> testo da inviare all'utente.
// Non salva nulla: chi lo invia usa notify(), che registra il messaggio nella cronologia.
export async function runTask(instruction) {
  if (!initialized) await initAI();

  const messages = [
    { role: 'system', content: buildSystemPrompt(instruction) },
    ...dbModule.getRecentMessages(HISTORY_LIMIT),
    {
      role: 'user',
      content:
        `[COMPITO AUTOMATICO: non è un messaggio dell'utente, è un'attività pianificata] ${instruction}\n\n` +
        'Scrivi direttamente il messaggio che verrà inviato all\'utente su Telegram, senza accennare al fatto che è un compito automatico.'
    }
  ];

  const text = await runLoop(messages);
  if (!text) throw new Error('Il modello non ha prodotto alcun testo per il compito automatico.');
  return text;
}
