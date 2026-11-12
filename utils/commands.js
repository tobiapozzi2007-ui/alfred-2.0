import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import db, { handlers as memory, searchItems } from './db.js';

// Comandi che NON passano dall'IA: rispondono sempre con i dati veri, anche quando l'IA sbaglia.

const run = promisify(execFile);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// Preferisce lo script versionato nella repository; altrimenti quello vecchio accanto alla cartella
const REPO_SCRIPT = path.join(ROOT, 'scripts', 'alfred-update.sh');
const UPDATE_SCRIPT =
  process.env.UPDATE_SCRIPT || (fs.existsSync(REPO_SCRIPT) ? REPO_SCRIPT : path.join(ROOT, '..', 'alfred-update.sh'));
const HEARTBEAT_FILE = process.env.UPDATE_HEARTBEAT || path.join(ROOT, '..', 'alfred-last-check.txt');
const PID_FILE = path.join(ROOT, 'alfred.pid');

const scrub = (text) => String(text || '').replace(/(https?:\/\/)[^@\s/]+@/g, '$1***@').trim();

async function git(args, timeout = 8000) {
  try {
    const { stdout } = await run('git', args, { cwd: ROOT, timeout });
    return { ok: true, out: stdout.trim() };
  } catch (err) {
    return { ok: false, out: '', err: scrub(err.stderr || err.message).split('\n')[0].slice(0, 300) };
  }
}

function duration(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return [d && `${d} g`, h && `${h} h`, `${m} min`].filter(Boolean).join(' ');
}

/* ------------------------------------------------------------------ */
/*  /stato                                                             */
/* ------------------------------------------------------------------ */

async function latestOnGitHub() {
  const remote = await git(['remote', 'get-url', 'origin']);
  const m = remote.ok ? /github\.com[/:]([^/]+)\/([^/\s]+?)(?:\.git)?$/.exec(scrub(remote.out)) : null;
  if (!m) return { error: 'repository GitHub non riconosciuta' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`https://api.github.com/repos/${m[1]}/${m[2]}/commits/main`, {
      headers: { 'User-Agent': 'Alfred-2.0', Accept: 'application/vnd.github+json' },
      signal: controller.signal
    });
    if (res.status === 404 || res.status === 403) {
      return { error: `GitHub non mi lascia leggere i commit (stato ${res.status}): repository privata o limite di richieste` };
    }
    if (!res.ok) return { error: `GitHub ha risposto con stato ${res.status}` };
    const data = await res.json();
    return { sha: data.sha, message: String(data.commit?.message || '').split('\n')[0] };
  } catch (err) {
    return { error: `GitHub non raggiungibile (${err.name === 'AbortError' ? 'timeout' : err.message})` };
  } finally {
    clearTimeout(timer);
  }
}

async function statusText({ toolCount }) {
  const lines = ['🦇 Stato di Alfred', ''];

  const local = await git(['log', '-1', '--format=%H|%h|%s|%cI']);
  let localSha = null;
  if (local.ok && local.out) {
    const [sha, hash, subject, date] = local.out.split('|');
    localSha = sha;
    const when = new Date(date).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' });
    lines.push(`Versione in esecuzione: ${hash} — ${subject} (${when})`);
  } else {
    lines.push(`Versione in esecuzione: non leggibile${local.err ? ` (git: ${local.err})` : ''}`);
  }

  const remote = await latestOnGitHub();
  if (remote.sha) {
    const aligned = localSha && remote.sha === localSha;
    lines.push(`Ultimo su GitHub: ${remote.sha.slice(0, 7)} — ${remote.message}`);
    lines.push(
      aligned
        ? '✅ Sono allineato con GitHub.'
        : localSha
        ? '⚠️ Sono indietro rispetto a GitHub: gli ultimi aggiornamenti non sono ancora arrivati sul NAS. Prova /aggiorna.'
        : '⚠️ Non riesco a confrontare le versioni.'
    );
  } else {
    lines.push(`Ultimo su GitHub: non verificabile (${remote.error}).`);
  }

  try {
    const age = (Date.now() - fs.statSync(HEARTBEAT_FILE).mtimeMs) / 60000;
    lines.push(
      age > 12
        ? `⚠️ L'ultimo controllo automatico degli aggiornamenti risale a ${Math.round(age)} minuti fa: l'attività programmata del NAS sembra ferma.`
        : `Ultimo controllo automatico degli aggiornamenti: ${Math.max(Math.round(age), 0)} minuti fa.`
    );
  } catch {
    /* il file del controllo non esiste: nessuna riga */
  }

  const mem = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(pinned), 0) AS p, COUNT(DISTINCT collection) AS c FROM items').get();
  lines.push('', `Acceso da: ${duration(process.uptime())}`);
  lines.push(`Strumenti disponibili: ${toolCount}`);
  lines.push(`Memoria: ${mem.n} ${mem.n === 1 ? 'voce' : 'voci'} in ${mem.c} ${mem.c === 1 ? 'spazio' : 'spazi'}, di cui ${mem.p} ${mem.p === 1 ? 'permanente' : 'permanenti'}.`);
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/*  /aggiorna                                                          */
/* ------------------------------------------------------------------ */

async function updateNow() {
  const fetched = await git(['fetch', 'origin', 'main'], 30_000);
  if (!fetched.ok) {
    const hint = /dubious ownership/i.test(fetched.err || '')
      ? `\n\nRimedio (da fare una volta sul NAS, con lo stesso utente che avvia il bot):\ngit config --global --add safe.directory ${ROOT}`
      : '';
    return `Non riesco a contattare GitHub dal NAS.\nErrore: ${fetched.err}${hint}`;
  }

  const local = await git(['rev-parse', 'HEAD']);
  const remote = await git(['rev-parse', 'FETCH_HEAD']);
  if (!local.ok || !remote.ok) return `Non riesco a leggere le versioni (git: ${local.err || remote.err}).`;
  if (local.out === remote.out) return `Sono già all'ultima versione (${local.out.slice(0, 7)}).`;

  if (!fs.existsSync(UPDATE_SCRIPT)) {
    return `C'è una versione nuova (${local.out.slice(0, 7)} → ${remote.out.slice(0, 7)}) ma non trovo lo script di aggiornamento in ${UPDATE_SCRIPT}.`;
  }

  // Così lo script può fermare proprio questo processo e riavviarlo
  try {
    fs.writeFileSync(PID_FILE, String(process.pid));
  } catch {
    /* non bloccante */
  }

  const child = spawn('bash', [UPDATE_SCRIPT], { detached: true, stdio: 'ignore' });
  child.unref();
  return `Trovata una versione nuova (${local.out.slice(0, 7)} → ${remote.out.slice(0, 7)}). Avvio l'aggiornamento: tra circa un minuto mi riavvio e ti scrivo.`;
}

/* ------------------------------------------------------------------ */
/*  Memoria                                                            */
/* ------------------------------------------------------------------ */

const line = (v) => `• (${v.id}${v.spazio ? `, ${v.spazio}` : ''}${v.sempre_visibile ? ', permanente' : ''}) ${v.contenuto}`;

function memoryText(query) {
  if (query) {
    const found = searchItems(query, { limit: 15 });
    if (!found.length) return `Nessun ricordo trovato per "${query}".`;
    return [`Ricordi trovati per "${query}":`, ...found.map((r) => line({ id: r.id, spazio: r.collection, sempre_visibile: r.pinned, contenuto: r.content }))].join('\n');
  }

  const overview = memory.read_memory({});
  if (!overview.spazi.length) return 'La memoria è vuota.';
  const out = [`Spazi di memoria: ${overview.spazi.map((s) => `${s.nome} (${s.voci})`).join(', ')}.`];
  if (overview.regole_permanenti.length) out.push('', 'Regole e informazioni permanenti:', ...overview.regole_permanenti.map(line));
  else out.push('', 'Non ci sono ancora regole permanenti.');
  out.push('', 'Per vedere altro: /memoria <parola>');
  return out.join('\n');
}

function saveText(content, { pinned, collection }) {
  if (!content) return `Scrivi cosa salvare, per esempio: /${pinned ? 'regola abito a Gemonio' : 'ricorda il compleanno di Luca è il 3 marzo'}`;
  const res = memory.save_to_memory({ collection, content, pinned });
  if (!res.success) return `Non sono riuscito a salvare: ${res.error}`;
  return res.azione.startsWith('aggiornata')
    ? `Esisteva già una voce simile (id ${res.id}): l'ho aggiornata.`
    : `Salvato (id ${res.id}${pinned ? ', permanente' : ''}).`;
}

// Elenco unico dei comandi: alimenta /aiuto, il menù di Telegram e il prompt dell'IA
export const COMMAND_LIST = [
  { command: 'aiuto', description: 'Elenco dei comandi', help: '/aiuto — questo elenco' },
  { command: 'stato', description: 'Versione, aggiornamenti e memoria', help: '/stato — versione, aggiornamenti e memoria' },
  { command: 'aggiorna', description: 'Controlla GitHub e aggiorna subito', help: '/aggiorna — controlla GitHub e aggiorna subito' },
  { command: 'memoria', description: 'Mostra cosa ricordo (o cerca una parola)', help: '/memoria — spazi di memoria e regole permanenti; /memoria <parola> cerca nei ricordi' },
  {
    command: 'regola',
    description: 'Salva una regola o un\'informazione sempre valida',
    help: '/regola <testo> — salva una regola o un\'informazione sempre valida (es. dove abiti, come firmare le email)'
  },
  { command: 'ricorda', description: 'Salva un ricordo normale', help: '/ricorda <testo> — salva un ricordo normale' },
  { command: 'dimentica', description: 'Elimina un ricordo tramite id', help: '/dimentica <id> — elimina un ricordo (gli id si vedono con /memoria)' },
  { command: 'reset', description: 'Azzera solo la conversazione recente', help: '/reset — azzera solo la conversazione recente, la memoria resta' }
];

const HELP = ['Comandi che funzionano sempre, senza passare dall\'IA:', ...COMMAND_LIST.map((c) => c.help)].join('\n');

/**
 * Esegue un comando e restituisce il testo di risposta, oppure null se il testo non è un comando noto.
 */
export async function handleCommand(text, { toolCount = 0 } = {}) {
  const match = /^\/([a-zà-ù]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(String(text || '').trim());
  if (!match) return null;
  const command = match[1].toLowerCase();
  const args = (match[2] || '').trim();

  switch (command) {
    case 'aiuto':
    case 'help':
      return HELP;
    case 'stato':
    case 'versione':
      return statusText({ toolCount });
    case 'aggiorna':
      return updateNow();
    case 'memoria':
      return memoryText(args);
    case 'regola':
      return saveText(args, { pinned: true, collection: 'regole' });
    case 'ricorda':
      return saveText(args, { pinned: false, collection: 'generale' });
    case 'dimentica': {
      if (!/^\d+$/.test(args)) return 'Indica l\'id del ricordo, per esempio: /dimentica 12 (gli id si vedono con /memoria).';
      return memory.delete_from_memory({ id: Number(args) }).success ? `Ricordo ${args} eliminato.` : `Non esiste un ricordo con id ${args}.`;
    }
    default:
      return null;
  }
}
