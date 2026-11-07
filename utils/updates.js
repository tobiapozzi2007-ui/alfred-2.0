import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import db from './db.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const UPDATE_FILE = path.join(ROOT, 'last_update.txt');

db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');

const getSetting = (key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
const setSetting = (key, value) =>
  db
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));

// Lo script di aggiornamento scrive qui: prima riga = hash breve, righe successive = messaggi dei commit
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
 * Dopo un aggiornamento (o un riavvio con strumenti cambiati) scrive all'utente
 * che Alfred si è aggiornato e quali nuove skill ha imparato.
 * catalog: [{ name, description, module }]
 */
export async function announceUpdate({ catalog, notify, runTask }) {
  const info = readUpdateFile();

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

  if (!info && !added.length && !removed.length) return; // riavvio normale: nessun messaggio

  const commitLines = info?.commits?.length ? info.commits.map((c) => `• ${c}`).join('\n') : null;

  // Nuove skill: le descrive l'IA, in modo semplice e con un esempio per ciascuna
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
      'Scrivi all\'utente un messaggio breve e chiaro che annuncia l\'aggiornamento e spiega in parole semplici cosa sai fare di nuovo.',
      'Raggruppa per tema, una o due frasi per capacità o gruppo, con un esempio concreto di cosa può chiederti.',
      'Non usare nomi tecnici di funzioni e non inventare capacità che non sono nell\'elenco.',
      'Non usare gli strumenti: basta l\'elenco qui sopra.'
    ]
      .filter(Boolean)
      .join('\n\n');

    try {
      const text = await runTask(instruction);
      await notify(`🦇 Mi sono aggiornato${info?.hash ? ` (versione ${info.hash})` : ''} e ho imparato cose nuove!\n\n${text}`);
      return;
    } catch (err) {
      console.error('[updates] Descrizione IA non riuscita, uso l\'elenco semplice:', err.message);
      const plain = added.slice(0, 15).map((t) => `• ${t.name}: ${short(t.description, 120)}`).join('\n');
      await notify(`🦇 Mi sono aggiornato${info?.hash ? ` (versione ${info.hash})` : ''}. Nuove skill:\n${plain}`);
      return;
    }
  }

  // Nessuna nuova skill: messaggio semplice, senza chiamare l'IA
  const parts = [`🦇 Mi sono aggiornato${info?.hash ? ` (versione ${info.hash})` : ''}.`];
  if (commitLines) parts.push(`Modifiche:\n${commitLines}`);
  if (removed.length) parts.push(`Skill rimosse: ${removed.join(', ')}.`);
  if (!removed.length) parts.push('Nessuna nuova skill questa volta: solo miglioramenti.');
  if (!previous) parts.push('Da ora in poi ti dirò anche quali nuove skill imparo a ogni aggiornamento.');
  await notify(parts.join('\n\n'));
}
