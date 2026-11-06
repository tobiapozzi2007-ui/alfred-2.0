import db from '../utils/db.js';
import { truncate } from '../utils/text.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS list_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    list_name TEXT NOT NULL,
    content TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    done_at DATETIME
  );
  CREATE INDEX IF NOT EXISTS idx_list_name ON list_entries (list_name);

  CREATE TABLE IF NOT EXISTS note_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

const normList = (name) => String(name || '').trim().toLowerCase();

// Trova una voce di una lista tramite id oppure testo (anche parziale)
function findItem(list, item, id) {
  if (id !== undefined && id !== null) {
    const row = db.prepare('SELECT * FROM list_entries WHERE id = ? AND list_name = ?').get(Number(id), list);
    if (!row) throw new Error(`Nessuna voce con id ${id} nella lista "${list}".`);
    return row;
  }
  const text = String(item || '').trim();
  if (!text) throw new Error('Indica la voce (testo o id).');

  const exact = db
    .prepare('SELECT * FROM list_entries WHERE list_name = ? AND lower(content) = lower(?)')
    .all(list, text);
  if (exact.length >= 1) return exact[0];

  const like = db
    .prepare('SELECT * FROM list_entries WHERE list_name = ? AND content LIKE ? ORDER BY id')
    .all(list, `%${text}%`);
  if (like.length === 1) return like[0];
  if (like.length > 1) {
    throw new Error(
      `Più voci corrispondono a "${text}": ${like.map((r) => `${r.id}) ${r.content}`).join('; ')}. Indica l'id.`
    );
  }
  throw new Error(`Voce "${text}" non trovata nella lista "${list}".`);
}

export const tools = [
  {
    type: 'function',
    function: {
      name: 'add_to_list',
      description:
        'Aggiunge una o più voci a una lista dell\'utente (spesa, cose da fare, regali, valigia, idee...). Usa questo strumento per le liste e non la memoria permanente. Se la lista non esiste viene creata.',
      parameters: {
        type: 'object',
        properties: {
          list: { type: 'string', description: 'Nome della lista (es. "spesa", "cose da fare").' },
          items: { type: 'array', items: { type: 'string' }, description: 'Voci da aggiungere, una per elemento.' }
        },
        required: ['list', 'items']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'show_list',
      description:
        'Mostra una lista con le voci da fare e quelle completate. Senza nome restituisce l\'elenco di tutte le liste con il numero di voci aperte.',
      parameters: {
        type: 'object',
        properties: {
          list: { type: 'string', description: 'Nome della lista (opzionale).' },
          include_done: { type: 'boolean', description: 'Includere anche le voci completate (default true).' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'check_list_item',
      description: 'Spunta una voce come completata (o la riapre con done=false), indicandola per testo o per id.',
      parameters: {
        type: 'object',
        properties: {
          list: { type: 'string' },
          item: { type: 'string', description: 'Testo (anche parziale) della voce.' },
          id: { type: 'integer', description: 'Id della voce, alternativo al testo.' },
          done: { type: 'boolean', description: 'true (default) completata, false riaperta.' }
        },
        required: ['list']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'remove_from_list',
      description: 'Elimina una voce da una lista, per testo o per id.',
      parameters: {
        type: 'object',
        properties: {
          list: { type: 'string' },
          item: { type: 'string' },
          id: { type: 'integer' }
        },
        required: ['list']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'clear_list',
      description:
        'Svuota una lista: di default elimina solo le voci già completate; con only_done=false elimina tutto e la lista sparisce.',
      parameters: {
        type: 'object',
        properties: {
          list: { type: 'string' },
          only_done: { type: 'boolean', description: 'Default true.' }
        },
        required: ['list']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'add_note',
      description: 'Salva una nota libera (appunto, idea, informazione da ritrovare) con un titolo opzionale.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Titolo breve (opzionale).' },
          content: { type: 'string', description: 'Testo della nota.' }
        },
        required: ['content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_notes',
      description: 'Cerca tra le note per testo (titolo o contenuto). Senza testo restituisce le più recenti.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'integer', description: 'Default 10, massimo 30.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_note',
      description: 'Elimina una nota tramite id.',
      parameters: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] }
    }
  }
];

export const handlers = {
  add_to_list({ list, items }) {
    const name = normList(list);
    if (!name) return { success: false, error: 'Nome della lista mancante.' };
    const values = (Array.isArray(items) ? items : [items])
      .map((i) => String(i ?? '').trim())
      .filter(Boolean);
    if (!values.length) return { success: false, error: 'Nessuna voce da aggiungere.' };

    const insert = db.prepare('INSERT INTO list_entries (list_name, content) VALUES (?, ?)');
    const added = [];
    const skipped = [];
    for (const value of values) {
      const dup = db
        .prepare('SELECT 1 FROM list_entries WHERE list_name = ? AND done = 0 AND lower(content) = lower(?)')
        .get(name, value);
      if (dup) {
        skipped.push(value);
        continue;
      }
      const info = insert.run(name, value);
      added.push({ id: Number(info.lastInsertRowid), voce: value });
    }
    return { success: true, lista: name, aggiunte: added, gia_presenti: skipped };
  },

  show_list({ list, include_done = true } = {}) {
    const name = normList(list);
    if (!name) {
      const lists = db
        .prepare(
          `SELECT list_name, SUM(CASE WHEN done = 0 THEN 1 ELSE 0 END) AS aperte, COUNT(*) AS totali
           FROM list_entries GROUP BY list_name ORDER BY list_name`
        )
        .all();
      return { liste: lists.map((l) => ({ nome: l.list_name, voci_aperte: l.aperte, voci_totali: l.totali })) };
    }

    const rows = db.prepare('SELECT * FROM list_entries WHERE list_name = ? ORDER BY done, id').all(name);
    if (!rows.length) return { lista: name, vuota: true };
    return {
      lista: name,
      da_fare: rows.filter((r) => !r.done).map((r) => ({ id: r.id, voce: r.content })),
      completate: include_done === false ? undefined : rows.filter((r) => r.done).map((r) => ({ id: r.id, voce: r.content }))
    };
  },

  check_list_item({ list, item, id, done = true }) {
    const name = normList(list);
    const row = findItem(name, item, id);
    db.prepare("UPDATE list_entries SET done = ?, done_at = CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END WHERE id = ?").run(
      done === false ? 0 : 1,
      done === false ? 0 : 1,
      row.id
    );
    const open = db.prepare('SELECT COUNT(*) AS n FROM list_entries WHERE list_name = ? AND done = 0').get(name).n;
    return { success: true, voce: row.content, completata: done !== false, voci_ancora_aperte: open };
  },

  remove_from_list({ list, item, id }) {
    const name = normList(list);
    const row = findItem(name, item, id);
    db.prepare('DELETE FROM list_entries WHERE id = ?').run(row.id);
    return { success: true, eliminata: row.content };
  },

  clear_list({ list, only_done = true }) {
    const name = normList(list);
    const info =
      only_done === false
        ? db.prepare('DELETE FROM list_entries WHERE list_name = ?').run(name)
        : db.prepare('DELETE FROM list_entries WHERE list_name = ? AND done = 1').run(name);
    return { success: true, lista: name, voci_eliminate: info.changes };
  },

  add_note({ title, content }) {
    if (!content || !String(content).trim()) return { success: false, error: 'Testo della nota mancante.' };
    const info = db
      .prepare('INSERT INTO note_entries (title, content) VALUES (?, ?)')
      .run(title ? String(title).trim() : null, String(content).trim());
    return { success: true, id: Number(info.lastInsertRowid) };
  },

  search_notes({ query, limit = 10 } = {}) {
    const cap = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 30);
    const rows = query
      ? db
          .prepare(
            `SELECT * FROM note_entries WHERE content LIKE ? OR title LIKE ? ORDER BY id DESC LIMIT ${cap}`
          )
          .all(`%${query}%`, `%${query}%`)
      : db.prepare(`SELECT * FROM note_entries ORDER BY id DESC LIMIT ${cap}`).all();
    return {
      trovate: rows.length,
      note: rows.map((n) => ({
        id: n.id,
        titolo: n.title,
        testo: truncate(n.content, 1500),
        creata: n.created_at
      }))
    };
  },

  delete_note({ id }) {
    const info = db.prepare('DELETE FROM note_entries WHERE id = ?').run(Number(id));
    return { success: info.changes > 0 };
  }
};
