import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import db from './db.js';

const run = promisify(execFile);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const UPDATE_FILE = path.join(ROOT, 'last_update.txt');

db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');

const getSetting = (key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
const setSetting = (key, value) =>
  db
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));

async function git(args) {
  try {
    const { stdout } = await run('git', args, { cwd: ROOT, timeout: 5000 });
    return stdout.trim();
  } catch {
    return null; // git non disponibile o cartella non versionata
  }
}

// Facoltativo: lo script di aggiornamento può scrivere qui hash breve (prima riga) e messaggi dei commit
function readUpdateFile() {
  if (!fs.existsSync(UPDATE_FILE)) return null;
  try {
    const lines = fs
      .readFileSync(UPDATE_FILE, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    return lines.length ? { hash: lines[0], commits: lines.slice(1) } : { hash: null, commits: [] };
  } catch {
    return null;
  } finally {
    try {
      fs.unlinkSync(UPDATE_FILE); // letto una volta sola: niente annunci ripetuti
    } catch {
      /* già rimosso */
    }
  }
}

const short = (text, max) => (String(text).length > max ? String(text).slice(0, max).trimEnd() + '…' : String(text));

/**
 * All'avvio scrive all'utente se Alfred si è aggiornato e quali nuove skill ha imparato.
 * Il cambio di versione si riconosce da solo confrontando il commit Git con quello dell'ultimo avvio,
 * quindi funziona anche senza che lo script di aggiornamento faccia nulla di speciale.
 * catalog: [{ name, description, module }]
 */
export async function announceUpdate({ catalog, notify, runTask }) {
  // 1) Quale versione gira ora e cosa è cambiato dall'ultimo avvio
  let info = readUpdateFile();
  const hadFile = Boolean(info);
  const head = await git(['rev-parse', 'HEAD']);
  const storedHead = getSetting('last_commit');

  if (!info && head && storedHead && storedHead !== head) {
    const subjects = await git(['log', '--pretty=%s', `${storedHead}..${head}`]);
    const shortHash = await git(['rev-parse', '--short', 'HEAD']);
    info = {
      hash: shortHash,
      commits: subjects ? subjects.split('\n').filter(Boolean).slice(0, 8) : []
    };
  }
  if (head) setSetting('last_commit', head);

  // 2) Quali skill sono nuove o sparite rispetto all'ultimo avvio
  const current = {};
  for (const t of catalog) current[t.name] = { module: t.module, description: t.description };

  let previous = null;
  try {
    previous = JSON.parse(getSetting('tool_snapshot') || 'null');
  } catch {
    previous = null;
  }
  setSetting('tool_snapshot', JSON.stringify(current));

  const added = previous ? catalog.filter((t) => !previous[t.name]) : [];
  const removed = previous ? Object.keys(previous).filter((n) => !current[n]) : [];

  const introPending = getSetting('update_intro_sent') !== '1';
  setSetting('update_intro_sent', '1');

  console.log(
    `[updates] versione ${head ? head.slice(0, 7) : 'sconosciuta'} (prima: ${storedHead ? storedHead.slice(0, 7) : 'nessuna'}), ` +
      `file aggiornamento: ${hadFile ? 'sì' : 'no'}, skill nuove: ${added.length}, rimosse: ${removed.length}`
  );

  // 3) Nessun cambiamento: riavvio normale
  if (!info && !added.length && !removed.length) {
    if (introPending) {
      await notify(
        '🦇 Ho attivato gli avvisi di aggiornamento: da ora, dopo ogni aggiornamento del mio codice ti scrivo cosa è cambiato e quali nuove skill ho imparato.'
      );
    }
    return;
  }

  const commitLines = info?.commits?.length ? info.commits.map((c) => `• ${c}`).join('\n') : null;
  const version = info?.hash ? ` (versione ${info.hash})` : '';

  // 4) Nuove skill: le descrive l'IA, in modo semplice e con un esempio per ciascuna
  if (added.length) {
    const byModule = {};
    for (const t of added.slice(0, 30)) (byModule[t.module] ||= []).push(`${t.name}: ${short(t.description, 300)}`);
    const listing = Object.entries(byModule)
      .map(([mod, items]) => `Modulo ${mod}:\n${items.map((i) => `  - ${i}`).join('\n')}`)
      .join('\n');

    const instruction = [
      'Sei appena stato aggiornato con del nuovo codice e hai imparato nuove capacità. Ecco quelle nuove:',
      listing,
      commitLines ? `Modifiche indicate negli aggiornamenti:\n${commitLines}` : '',
      "Scrivi all'utente un messaggio breve e chiaro che annuncia l'aggiornamento e spiega in parole semplici cosa sai fare di nuovo.",
      'Raggruppa per tema, una o due frasi per capacità o gruppo, con un esempio concreto di cosa può chiederti.',
      "Non usare nomi tecnici di funzioni e non inventare capacità che non sono nell'elenco.",
      "Non usare gli strumenti: basta l'elenco qui sopra."
    ]
      .filter(Boolean)
      .join('\n\n');

    try {
      const text = await runTask(instruction);
      await notify(`🦇 Mi sono aggiornato${version} e ho imparato cose nuove!\n\n${text}`);
    } catch (err) {
      console.error("[updates] Descrizione IA non riuscita, uso l'elenco semplice:", err.message);
      const plain = added.slice(0, 15).map((t) => `• ${t.name}: ${short(t.description, 120)}`).join('\n');
      await notify(`🦇 Mi sono aggiornato${version}. Nuove skill:\n${plain}`);
    }
    return;
  }

  // 5) Nessuna nuova skill: messaggio semplice, senza chiamare l'IA
  const parts = [`🦇 Mi sono aggiornato${version}.`];
  if (commitLines) parts.push(`Modifiche:\n${commitLines}`);
  if (removed.length) parts.push(`Skill rimosse: ${removed.join(', ')}.`);
  else parts.push('Nessuna nuova skill questa volta: solo miglioramenti.');
  await notify(parts.join('\n\n'));
}
