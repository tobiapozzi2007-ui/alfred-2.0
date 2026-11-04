import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'alfred_memory.sqlite');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

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
/*  Memoria permanente (tabella items) - esposta come tool             */
/* ------------------------------------------------------------------ */

const normalizeCollection = (c) => String(c || '').trim().toLowerCase();

export const tools = [
  {
    type: 'function',
    function: {
      name: 'save_to_memory',
      description:
        'Salva un elemento nella memoria permanente, organizzata per collezioni (es. "profilo" per informazioni sull\'utente, "spesa" per la lista della spesa, "note" per appunti liberi). Usalo quando l\'utente chiede di ricordare, annotare o aggiungere qualcosa, o quando emerge un\'informazione personale duratura.',
      parameters: {
        type: 'object',
        properties: {
          collection: {
            type: 'string',
            description: 'Nome della collezione (es. "profilo", "spesa", "note").'
          },
          content: {
            type: 'string',
            description: 'Contenuto da salvare, scritto in modo chiaro e autosufficiente.'
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
        'Legge dalla memoria permanente. Senza parametri elenca tutte le collezioni esistenti con il numero di elementi; con "collection" restituisce gli elementi di quella collezione; con "query" filtra per testo.',
      parameters: {
        type: 'object',
        properties: {
          collection: {
            type: 'string',
            description: 'Collezione da leggere (opzionale).'
          },
          query: {
            type: 'string',
            description: 'Testo da cercare all\'interno degli elementi (opzionale).'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_from_memory',
      description:
        'Elimina un elemento dalla memoria permanente tramite il suo id (ottenibile con read_memory). Usalo quando l\'utente chiede di togliere o dimenticare qualcosa.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: 'Id dell\'elemento da eliminare.' }
        },
        required: ['id']
      }
    }
  }
];

export const handlers = {
  save_to_memory({ collection, content }) {
    const col = normalizeCollection(collection);
    if (!col || !content || !String(content).trim()) {
      return { success: false, error: 'Servono sia "collection" sia "content".' };
    }
    const info = db
      .prepare('INSERT INTO items (collection, content) VALUES (?, ?)')
      .run(col, String(content).trim());
    return { success: true, id: Number(info.lastInsertRowid), collection: col };
  },

  read_memory({ collection, query } = {}) {
    const col = normalizeCollection(collection);
    const q = query ? `%${String(query).trim()}%` : null;

    if (!col && !q) {
      const collections = db
        .prepare('SELECT collection, COUNT(*) AS count FROM items GROUP BY collection ORDER BY collection')
        .all();
      return { collections };
    }

    const where = [];
    const params = [];
    if (col) {
      where.push('collection = ?');
      params.push(col);
    }
    if (q) {
      where.push('content LIKE ?');
      params.push(q);
    }
    const rows = db
      .prepare(
        `SELECT id, collection, content, created_at FROM items WHERE ${where.join(' AND ')} ORDER BY id ASC LIMIT 200`
      )
      .all(...params);
    return { count: rows.length, items: rows };
  },

  delete_from_memory({ id }) {
    const info = db.prepare('DELETE FROM items WHERE id = ?').run(Number(id));
    return { success: info.changes > 0, deleted: info.changes };
  }
};

export default db;
