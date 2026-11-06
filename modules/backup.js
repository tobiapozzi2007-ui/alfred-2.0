import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import db from '../utils/db.js';
import { nowParts, formatLocal } from '../utils/time.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PREFIX = 'alfred_memory_';
const SUFFIX = '.sqlite';

const backupDir = () => process.env.BACKUP_DIR || path.join(ROOT, 'backups');
const keepCount = () => Math.max(parseInt(process.env.BACKUP_KEEP, 10) || 14, 1);
const BACKUP_HOUR = Math.min(Math.max(parseInt(process.env.BACKUP_HOUR, 10) || 3, 0), 23);

function listFiles() {
  const dir = backupDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(PREFIX) && f.endsWith(SUFFIX))
    .sort(); // il nome contiene la data: ordine alfabetico = ordine cronologico
}

async function runBackup() {
  const dir = backupDir();
  fs.mkdirSync(dir, { recursive: true });

  const now = nowParts();
  const stamp = `${now.date}_${String(now.hour).padStart(2, '0')}${String(now.minute).padStart(2, '0')}`;
  const dest = path.join(dir, `${PREFIX}${stamp}${SUFFIX}`);

  // Copia coerente anche con il database in uso (modalità WAL)
  await db.backup(dest);

  // Elimina i backup più vecchi oltre il numero da conservare
  const files = listFiles();
  const removed = [];
  for (const f of files.slice(0, Math.max(files.length - keepCount(), 0))) {
    fs.unlinkSync(path.join(dir, f));
    removed.push(f);
  }

  return { file: dest, size: fs.statSync(dest).size, removed };
}

export const tools = [
  {
    type: 'function',
    function: {
      name: 'backup_database_now',
      description:
        'Crea subito una copia di sicurezza del database di Alfred (memoria, spese, abitudini, liste, promemoria...). Ogni notte ne viene fatta una automatica.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_backups',
      description: 'Elenca i backup del database disponibili, con data e dimensione.',
      parameters: { type: 'object', properties: {} }
    }
  }
];

export const handlers = {
  async backup_database_now() {
    const res = await runBackup();
    return {
      success: true,
      cartella: path.dirname(res.file),
      file: path.basename(res.file),
      dimensione_kb: Math.round(res.size / 1024),
      backup_vecchi_eliminati: res.removed.length
    };
  },

  list_backups() {
    const dir = backupDir();
    const files = listFiles().reverse();
    return {
      cartella: dir,
      conservati_al_massimo: keepCount(),
      totale: files.length,
      backup: files.map((f) => {
        const st = fs.statSync(path.join(dir, f));
        return { file: f, dimensione_kb: Math.round(st.size / 1024), creato: formatLocal(st.mtime) };
      })
    };
  }
};

/* ------------------------------------------------------------------ */
/*  Backup automatico notturno (hook init)                             */
/* ------------------------------------------------------------------ */

export function init(ctx) {
  let busy = false;
  let failedOn = null; // se fallisce, niente nuovi tentativi né avvisi fino al giorno dopo

  const tick = async () => {
    if (busy) return;
    const now = nowParts();
    if (now.hour < BACKUP_HOUR || failedOn === now.date) return;
    if (listFiles().some((f) => f.startsWith(`${PREFIX}${now.date}_`))) return; // già fatto oggi

    busy = true;
    try {
      const res = await runBackup();
      console.log(`[backup] Creato ${path.basename(res.file)} (${Math.round(res.size / 1024)} KB).`);
    } catch (err) {
      console.error('[backup] Errore:', err);
      failedOn = now.date;
      // Avvisa solo se qualcosa va storto
      ctx.notify(`⚠️ Il backup automatico del database non è riuscito: ${err.message}`).catch(() => {});
    } finally {
      busy = false;
    }
  };

  setInterval(tick, 10 * 60_000);
  tick();
  console.log(`[backup] Attivo: copia ogni notte dopo le ${String(BACKUP_HOUR).padStart(2, '0')}:00 in ${backupDir()}.`);
}
