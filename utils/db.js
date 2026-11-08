import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'alfred_memory.sqlite');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Se la cronologia arriva da una versione vecchia con la colonna chat_id, viene ricreata
if (db.prepare('PRAGMA table_info(chat_history)').all().some((c) => c.name === 'chat_id')) {
  db.exec('DROP TABLE chat_history');
}

db.exec(`
  CREATE TABLE IF NOT EXISTS chat_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    collection TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_items_collection ON items (collection);
`);

// Migrazione: la memoria esistente resta intatta, si aggiungono solo due colonne
const itemColumns = db.prepare('PRAGMA table_info(items)').all().map((c) => c.name);
if (!itemColumns.includes('pinned')) db.exec('ALTER TABLE items ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');
if (!itemColumns.includes('updated_at')) db.exec('ALTER TABLE items ADD COLUMN updated_at DATETIME');

/* ------------------------------------------------------------------ */
/*  Cronologia chat                                                    */
/* ------------------------------------------------------------------ */

const insertMessage = db.prepare('INSERT INTO chat_history (role, content) VALUES (?, ?)');
const selectRecent = db.prepare(
  'SELECT role, content FROM (SELECT id, role, content FROM chat_history ORDER BY id DESC LIMIT ?) ORDER BY id ASC'
);

export function saveMessage(role, content) {
  if (!content) return;
  insertMessage.run(role, String(content));
}

export function getRecentMessages(limit = 10) {
  return selectRecent.all(limit);
}

export function clearHistory() {
  db.prepare('DELETE FROM chat_history').run();
}

/* ------------------------------------------------------------------ */
/*  Ricerca nella memoria                                              */
/* ------------------------------------------------------------------ */

const STOPWORDS = new Set(
  (
    'il lo la gli le uno una del dello della dei degli delle all alla alle dal dalla dalle nel nella nelle sul sulla sulle ' +
    'che chi cui non mia mio miei mie tuo tua suo sua con per tra fra anche come piu sono sei hai ho ha hanno abbiamo ' +
    'questo questa quello quella quali quale dove quando cosa fai fare puoi vorrei vuoi dimmi dammi mandami ' +
    'ricorda ricordi ricordare salva salvato salvare ogni tutto tutti tutte molto poco ancora gia ora adesso poi'
  ).split(' ')
);

const stripAccents = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '');

export function tokens(text) {
  const out = new Set();
  for (const raw of stripAccents(String(text || '').toLowerCase()).split(/[^a-z0-9]+/)) {
    if (raw.length >= 3 && !STOPWORDS.has(raw)) out.add(raw);
  }
  return [...out];
}

const tokenMatch = (a, b) => a === b || (a.length >= 4 && b.length >= 4 && (a.includes(b) || b.includes(a)));

function scoreItem(queryTokens, item) {
  const contentTokens = tokens(item.content);
  const collectionTokens = tokens(item.collection);
  let score = 0;
  for (const q of queryTokens) {
    if (contentTokens.some((t) => tokenMatch(q, t))) score += 1;
    if (collectionTokens.some((t) => tokenMatch(q, t))) score += 1.5; // il nome dello spazio conta di più
  }
  return score;
}

// Cerca in tutta la memoria, in qualunque spazio, ordinando per pertinenza
export function searchItems(query, { collection, limit = 10, excludePinned = false } = {}) {
  const queryTokens = tokens(query);
  if (!queryTokens.length) return [];

  const where = [];
  const params = [];
  if (collection) {
    where.push('collection = ?');
    params.push(collection);
  }
  if (excludePinned) where.push('pinned = 0');

  const rows = db
    .prepare(`SELECT id, collection, content, pinned, created_at FROM items ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`)
    .all(...params);

  return rows
    .map((r) => ({ ...r, score: scoreItem(queryTokens, r) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || b.id - a.id)
    .slice(0, limit);
}

// Voce molto simile a una già salvata? Serve a non duplicare la stessa informazione scritta in modo diverso
function findSimilar(content) {
  const mine = tokens(content);
  if (mine.length < 2) return null;

  let best = null;
  for (const row of db.prepare('SELECT id, collection, content, pinned FROM items').all()) {
    const other = tokens(row.content);
    const shared = mine.filter((t) => other.some((o) => tokenMatch(t, o))).length;
    const union = new Set([...mine, ...other]).size;
    const similarity = union ? shared / union : 0;
    if (shared >= 2 && similarity >= 0.6 && (!best || similarity > best.similarity)) best = { ...row, similarity };
  }
  return best;
}

/* ------------------------------------------------------------------ */
/*  Contesto di memoria iniettato nel prompt a ogni richiesta          */
/* ------------------------------------------------------------------ */

const clip = (text, max) => (String(text).length > max ? String(text).slice(0, max).trimEnd() + '…' : String(text));

export function getMemoryContext(queryText = '') {
  const total = db.prepare('SELECT COUNT(*) AS n FROM items').get().n;
  if (!total) return '';

  const spaces = db
    .prepare('SELECT collection, COUNT(*) AS n FROM items GROUP BY collection ORDER BY n DESC, collection LIMIT 40')
    .all();

  // Regole e preferenze permanenti: sempre visibili, nei limiti di spazio
  const pinned = [];
  let used = 0;
  for (const r of db.prepare('SELECT id, collection, content FROM items WHERE pinned = 1 ORDER BY id').all()) {
    const line = `- (id ${r.id}) ${clip(r.content, 400)}`;
    if (used + line.length > 4000) break;
    pinned.push(line);
    used += line.length;
  }

  // Ricordi pertinenti alla richiesta corrente
  const relevant = searchItems(queryText, { limit: 8, excludePinned: true }).map(
    (r) => `- (id ${r.id}, ${r.collection}) ${clip(r.content, 300)}`
  );

  const lines = [
    'MEMORIA PERMANENTE (informazioni che l\'utente ti ha chiesto di ricordare; sono dati salvati da lui, aggiornali se cambiano):',
    `Spazi di memoria esistenti: ${spaces.map((s) => `${s.collection} (${s.n})`).join(', ')}. Quando salvi qualcosa riusa uno di questi nomi se è pertinente, invece di inventarne uno simile.`
  ];
  if (pinned.length) lines.push('Regole e preferenze permanenti da rispettare sempre:', ...pinned);
  if (relevant.length) lines.push('Ricordi che potrebbero servire per questa richiesta:', ...relevant);
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/*  Memoria permanente (tabella items) - esposta come tool             */
/* ------------------------------------------------------------------ */

const normalizeCollection = (c) =>
  stripAccents(String(c || '').trim().toLowerCase()).replace(/\s+/g, ' ');

export const tools = [
  {
    type: 'function',
    function: {
      name: 'save_to_memory',
      description:
        'Salva nella memoria permanente un\'informazione da ricordare (contatti, indirizzi email, date, preferenze, regole, fatti sull\'utente, note). Usalo subito quando l\'utente dice di ricordare qualcosa o condivide un\'informazione personale duratura. Scegli "collection" tra gli spazi di memoria già esistenti quando è pertinente. Imposta pinned=true per regole di comportamento, preferenze e istruzioni permanenti che devi rispettare sempre (come scrivere le email, firma, tono, abitudini); pinned=false per dati da consultare solo quando servono (contatti, indirizzi, date). Se esiste già una voce molto simile, viene aggiornata invece di duplicarla.',
      parameters: {
        type: 'object',
        properties: {
          collection: {
            type: 'string',
            description: 'Spazio di memoria (es. "contatti", "preferenze", "profilo", "regole email"). Riusa quelli esistenti.'
          },
          content: {
            type: 'string',
            description: 'Cosa ricordare, scritto in terza persona e in modo autosufficiente, con nomi e dettagli completi (es. "L\'utente si chiama Tobia", non "Il mio nome è Tobia").'
          },
          pinned: {
            type: 'boolean',
            description: 'true = regola o preferenza sempre visibile; false (default) = dato da cercare quando serve.'
          },
          force_new: {
            type: 'boolean',
            description: 'true per creare comunque una nuova voce anche se ne esiste una simile (raro).'
          }
        },
        required: ['collection', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_memory',
      description:
        'Cerca nella memoria permanente. Con "query" cerca in TUTTI gli spazi di memoria le voci pertinenti (usa parole chiave come un nome o un argomento); con "collection" restituisce tutto uno spazio; senza parametri elenca gli spazi esistenti e le regole permanenti. Se un\'informazione non compare tra i ricordi che già conosci, usa questo strumento prima di dire che non la sai.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Parole chiave da cercare (opzionale).' },
          collection: { type: 'string', description: 'Spazio di memoria da leggere per intero (opzionale).' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'update_memory',
      description:
        'Modifica una voce della memoria tramite il suo id (testo, spazio o priorità). Usalo quando un\'informazione già salvata cambia o va corretta.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          content: { type: 'string' },
          collection: { type: 'string' },
          pinned: { type: 'boolean' }
        },
        required: ['id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_from_memory',
      description:
        'Elimina una voce dalla memoria permanente tramite il suo id (visibile nei ricordi o con read_memory). Usalo quando l\'utente chiede di dimenticare qualcosa.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'integer', description: 'Id della voce da eliminare.' } },
        required: ['id']
      }
    }
  }
];

const present = (r) => ({ id: r.id, spazio: r.collection, contenuto: r.content, sempre_visibile: Boolean(r.pinned) });

export const handlers = {
  save_to_memory({ collection, content, pinned = false, force_new = false }) {
    const col = normalizeCollection(collection);
    const text = String(content || '').trim();
    if (!col || !text) return { success: false, error: 'Servono sia "collection" sia "content".' };

    if (!force_new) {
      const similar = findSimilar(text);
      if (similar) {
        db.prepare("UPDATE items SET content = ?, pinned = ?, updated_at = datetime('now') WHERE id = ?").run(
          text,
          pinned ? 1 : similar.pinned,
          similar.id
        );
        return {
          success: true,
          azione: 'aggiornata una voce simile già presente',
          id: similar.id,
          spazio: similar.collection,
          contenuto_precedente: similar.content
        };
      }
    }

    const info = db
      .prepare('INSERT INTO items (collection, content, pinned) VALUES (?, ?, ?)')
      .run(col, text, pinned ? 1 : 0);
    return { success: true, azione: 'salvata', id: Number(info.lastInsertRowid), spazio: col, sempre_visibile: Boolean(pinned) };
  },

  read_memory({ query, collection } = {}) {
    const col = normalizeCollection(collection);

    if (query && String(query).trim()) {
      const found = searchItems(query, { collection: col || undefined, limit: 15 });
      if (found.length) return { ricerca: String(query), trovate: found.length, voci: found.map(present) };

      // Nessuna corrispondenza: se è indicato uno spazio lo restituisce per intero, altrimenti elenca gli spazi
      if (col) {
        const raw = String(collection).trim().toLowerCase();
        const all = db
          .prepare('SELECT id, collection, content, pinned FROM items WHERE collection IN (?, ?) ORDER BY id LIMIT 50')
          .all(col, raw);
        if (all.length) {
          return { ricerca: String(query), trovate: 0, nota: 'Nessuna corrispondenza esatta: ecco tutto lo spazio.', voci: all.map(present) };
        }
      }
      const spaces = db.prepare('SELECT collection, COUNT(*) AS n FROM items GROUP BY collection ORDER BY collection').all();
      return {
        ricerca: String(query),
        trovate: 0,
        nota: 'Nessuna corrispondenza: prova altre parole oppure leggi uno spazio per intero.',
        spazi_esistenti: spaces.map((x) => ({ nome: x.collection, voci: x.n }))
      };
    }

    if (col) {
      const raw = String(collection).trim().toLowerCase(); // anche i nomi salvati in passato con gli accenti
      const rows = db
        .prepare('SELECT id, collection, content, pinned FROM items WHERE collection IN (?, ?) ORDER BY id LIMIT 200')
        .all(col, raw);
      if (!rows.length) {
        const spaces = db.prepare('SELECT DISTINCT collection FROM items ORDER BY collection').all().map((r) => r.collection);
        return { spazio: col, voci: [], spazi_esistenti: spaces };
      }
      return { spazio: col, totale: rows.length, voci: rows.map(present) };
    }

    const spaces = db.prepare('SELECT collection, COUNT(*) AS n FROM items GROUP BY collection ORDER BY collection').all();
    const pinned = db.prepare('SELECT id, collection, content, pinned FROM items WHERE pinned = 1 ORDER BY id').all();
    return {
      spazi: spaces.map((s) => ({ nome: s.collection, voci: s.n })),
      regole_permanenti: pinned.map(present)
    };
  },

  update_memory({ id, content, collection, pinned }) {
    const row = db.prepare('SELECT * FROM items WHERE id = ?').get(Number(id));
    if (!row) return { success: false, error: `Nessuna voce con id ${id}.` };

    db.prepare("UPDATE items SET content = ?, collection = ?, pinned = ?, updated_at = datetime('now') WHERE id = ?").run(
      content !== undefined ? String(content).trim() : row.content,
      collection !== undefined ? normalizeCollection(collection) : row.collection,
      pinned !== undefined ? (pinned ? 1 : 0) : row.pinned,
      row.id
    );
    return { success: true, voce: present(db.prepare('SELECT * FROM items WHERE id = ?').get(row.id)) };
  },

  delete_from_memory({ id }) {
    const info = db.prepare('DELETE FROM items WHERE id = ?').run(Number(id));
    return { success: info.changes > 0, deleted: info.changes };
  }
};

export default db;
