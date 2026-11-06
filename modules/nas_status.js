import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';

const run = promisify(execFile);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG_FILE = path.join(ROOT, 'alfred.log');
const DB_FILE = path.join(ROOT, 'alfred_memory.sqlite');
const DISK_PATH = process.env.NAS_DISK_PATH || '/volume1';

const gb = (bytes) => Math.round((bytes / 1024 ** 3) * 10) / 10;

function formatDuration(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return [d && `${d} giorni`, h && `${h} ore`, `${m} minuti`].filter(Boolean).join(' ');
}

async function diskUsage(mount) {
  try {
    const { stdout } = await run('df', ['-k', mount], { timeout: 5000 });
    const cols = stdout.trim().split('\n').pop().trim().split(/\s+/);
    const total = Number(cols[1]) * 1024;
    const used = Number(cols[2]) * 1024;
    const free = Number(cols[3]) * 1024;
    if (![total, used, free].every(Number.isFinite)) return null;
    return {
      percorso: mount,
      totale_gb: gb(total),
      usato_gb: gb(used),
      libero_gb: gb(free),
      usato_percento: Math.round((used / total) * 100)
    };
  } catch {
    return null;
  }
}

// Toglie dal log token e chiavi, nel caso finissero in un messaggio di errore
function redact(text) {
  return text
    .replace(/sk-or-v1-[A-Za-z0-9]+/g, '[chiave nascosta]')
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g, '[token nascosto]')
    .replace(/(pass(word)?|token|secret|key)(["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1$3[nascosto]');
}

export const tools = [
  {
    type: 'function',
    function: {
      name: 'get_nas_status',
      description:
        'Mostra lo stato del NAS su cui gira Alfred: spazio su disco, memoria, carico, tempo di attività del NAS e del bot, dimensione del database. Usalo solo quando l\'utente chiede dello stato del NAS o del bot.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_bot_log',
      description:
        'Legge le ultime righe del registro di Alfred (alfred.log), utile per capire se ci sono errori. Usalo solo se l\'utente lo chiede.',
      parameters: {
        type: 'object',
        properties: {
          lines: { type: 'integer', description: 'Numero di righe (default 30, massimo 100).' }
        }
      }
    }
  }
];

export const handlers = {
  async get_nas_status() {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const [l1, l5, l15] = os.loadavg();

    let dbSize = null;
    try {
      dbSize = Math.round((fs.statSync(DB_FILE).size / 1024 / 1024) * 100) / 100;
    } catch {
      /* database non ancora presente */
    }

    return {
      nas: {
        sistema: `${os.type()} ${os.release()} (${os.arch()})`,
        attivo_da: formatDuration(os.uptime()),
        cpu_core: os.cpus().length,
        carico_medio: { '1_min': l1.toFixed(2), '5_min': l5.toFixed(2), '15_min': l15.toFixed(2) }
      },
      memoria: {
        totale_gb: gb(totalMem),
        libera_gb: gb(freeMem),
        usata_percento: Math.round(((totalMem - freeMem) / totalMem) * 100)
      },
      disco: await diskUsage(DISK_PATH),
      bot: {
        attivo_da: formatDuration(process.uptime()),
        node: process.version,
        memoria_usata_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        database_mb: dbSize
      }
    };
  },

  read_bot_log({ lines = 30 } = {}) {
    const n = Math.min(Math.max(parseInt(lines, 10) || 30, 1), 100);
    if (!fs.existsSync(LOG_FILE)) return { error: 'File di log non trovato.' };

    // Legge solo la parte finale del file
    const size = fs.statSync(LOG_FILE).size;
    const length = Math.min(size, 64 * 1024);
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(LOG_FILE, 'r');
    try {
      fs.readSync(fd, buffer, 0, length, size - length);
    } finally {
      fs.closeSync(fd);
    }

    const rows = buffer.toString('utf8').split('\n').filter(Boolean).slice(-n);
    return { righe: rows.length, log: redact(rows.join('\n')) };
  }
};
