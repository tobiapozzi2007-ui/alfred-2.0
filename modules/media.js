import db from '../utils/db.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS media_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'da_provare',
    rating INTEGER,
    platform TEXT,
    notes TEXT,
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_media_cat ON media_entries (category, status);
`);

const STATUSES = ['da_provare', 'in_corso', 'completato', 'abbandonato'];
const STATUS_HELP =
  'da_provare (da vedere/giocare/leggere), in_corso, completato, abbandonato.';

// Normalizza le categorie più comuni, così "film" e "Film" o "videogiochi" finiscono insieme
function normCategory(value) {
  const c = String(value || '').trim().toLowerCase();
  const map = {
    films: 'film',
    movie: 'film',
    movies: 'film',
    'serie tv': 'serie',
    serietv: 'serie',
    series: 'serie',
    videogiochi: 'videogioco',
    videogame: 'videogioco',
    videogames: 'videogioco',
    giochi: 'videogioco',
    gioco: 'videogioco',
    libri: 'libro',
    book: 'libro',
    books: 'libro',
    podcasts: 'podcast',
    album: 'musica',
    canzone: 'musica'
  };
  return map[c] || c || 'altro';
}

function findEntry({ id, title, category }) {
  if (id !== undefined && id !== null) {
    const row = db.prepare('SELECT * FROM media_entries WHERE id = ?').get(Number(id));
    if (!row) throw new Error(`Nessun elemento con id ${id}.`);
    return row;
  }
  const text = String(title || '').trim();
  if (!text) throw new Error('Indica il titolo o l\'id.');

  const params = [`%${text}%`];
  let sql = 'SELECT * FROM media_entries WHERE title LIKE ?';
  if (category) {
    sql += ' AND category = ?';
    params.push(normCategory(category));
  }
  const rows = db.prepare(sql + ' ORDER BY id').all(...params);
  const exact = rows.filter((r) => r.title.toLowerCase() === text.toLowerCase());
  if (exact.length === 1) return exact[0];
  if (rows.length === 1) return rows[0];
  if (rows.length > 1) {
    throw new Error(`Più elementi corrispondono: ${rows.map((r) => `${r.id}) ${r.title} [${r.category}]`).join('; ')}. Indica l'id.`);
  }
  throw new Error(`Nessun elemento trovato con "${text}".`);
}

export const tools = [
  {
    type: 'function',
    function: {
      name: 'add_media',
      description:
        'Aggiunge un titolo a una delle liste dell\'utente di intrattenimento: film, serie, videogioco, libro, musica, podcast, anime o altra categoria. Di default finisce in "da_provare" (da vedere, da giocare, da leggere).',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Titolo.' },
          category: { type: 'string', description: 'film, serie, videogioco, libro, musica, podcast, anime...' },
          status: { type: 'string', enum: STATUSES, description: `Stato iniziale (default da_provare): ${STATUS_HELP}` },
          platform: { type: 'string', description: 'Dove vederlo/giocarlo (es. Netflix, PS5, Steam). Opzionale.' },
          notes: { type: 'string', description: 'Note, motivo per cui interessa, chi l\'ha consigliato. Opzionale.' },
          rating: { type: 'integer', description: 'Voto da 1 a 10, se già visto/giocato. Opzionale.' }
        },
        required: ['title', 'category']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_media',
      description:
        'Mostra le liste di intrattenimento, filtrabili per categoria, stato o testo. Senza filtri riassume quante voci ci sono per categoria e stato.',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string' },
          status: { type: 'string', enum: STATUSES },
          query: { type: 'string', description: 'Testo da cercare nel titolo o nelle note.' },
          limit: { type: 'integer', description: 'Default 30, massimo 100.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'update_media',
      description:
        'Aggiorna un elemento (per id o titolo): cambia stato (es. completato), voto, piattaforma o note. Quando l\'utente dice di aver finito o iniziato qualcosa usa questo strumento.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          title: { type: 'string', description: 'Titolo (anche parziale), alternativo all\'id.' },
          category: { type: 'string', description: 'Aiuta a distinguere titoli omonimi.' },
          status: { type: 'string', enum: STATUSES },
          rating: { type: 'integer', description: 'Voto da 1 a 10.' },
          platform: { type: 'string' },
          notes: { type: 'string' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'remove_media',
      description: 'Elimina un elemento dalle liste di intrattenimento (per id o titolo).',
      parameters: {
        type: 'object',
        properties: { id: { type: 'integer' }, title: { type: 'string' }, category: { type: 'string' } }
      }
    }
  }
];

const present = (r) => ({
  id: r.id,
  titolo: r.title,
  categoria: r.category,
  stato: r.status,
  voto: r.rating,
  piattaforma: r.platform,
  note: r.notes
});

function checkRating(rating) {
  const n = parseInt(rating, 10);
  if (!Number.isFinite(n) || n < 1 || n > 10) throw new Error('Il voto deve essere un numero da 1 a 10.');
  return n;
}

export const handlers = {
  add_media({ title, category, status = 'da_provare', platform, notes, rating }) {
    const t = String(title || '').trim();
    if (!t) return { success: false, error: 'Titolo mancante.' };
    if (!STATUSES.includes(status)) return { success: false, error: `Stato non valido: ${STATUS_HELP}` };
    const cat = normCategory(category);

    const dup = db
      .prepare('SELECT * FROM media_entries WHERE category = ? AND lower(title) = lower(?)')
      .get(cat, t);
    if (dup) return { success: false, error: 'Già presente.', esistente: present(dup) };

    const info = db
      .prepare('INSERT INTO media_entries (category, title, status, rating, platform, notes) VALUES (?, ?, ?, ?, ?, ?)')
      .run(
        cat,
        t,
        status,
        rating !== undefined ? checkRating(rating) : null,
        platform ? String(platform).trim() : null,
        notes ? String(notes).trim() : null
      );
    return { success: true, id: Number(info.lastInsertRowid), titolo: t, categoria: cat, stato: status };
  },

  list_media({ category, status, query, limit = 30 } = {}) {
    if (!category && !status && !query) {
      const rows = db
        .prepare('SELECT category, status, COUNT(*) AS n FROM media_entries GROUP BY category, status ORDER BY category, status')
        .all();
      const summary = {};
      for (const r of rows) (summary[r.category] ||= {})[r.status] = r.n;
      return { riepilogo_per_categoria: summary };
    }

    const where = [];
    const params = [];
    if (category) {
      where.push('category = ?');
      params.push(normCategory(category));
    }
    if (status) {
      where.push('status = ?');
      params.push(status);
    }
    if (query) {
      where.push('(title LIKE ? OR notes LIKE ?)');
      params.push(`%${query}%`, `%${query}%`);
    }
    const cap = Math.min(Math.max(parseInt(limit, 10) || 30, 1), 100);
    const rows = db
      .prepare(`SELECT * FROM media_entries WHERE ${where.join(' AND ')} ORDER BY updated_at DESC, id DESC LIMIT ${cap}`)
      .all(...params);
    return { trovati: rows.length, elementi: rows.map(present) };
  },

  update_media({ id, title, category, status, rating, platform, notes }) {
    const row = findEntry({ id, title, category });
    if (status !== undefined && !STATUSES.includes(status)) {
      return { success: false, error: `Stato non valido: ${STATUS_HELP}` };
    }
    db.prepare(
      `UPDATE media_entries SET status = ?, rating = ?, platform = ?, notes = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(
      status ?? row.status,
      rating !== undefined ? checkRating(rating) : row.rating,
      platform !== undefined ? String(platform).trim() : row.platform,
      notes !== undefined ? String(notes).trim() : row.notes,
      row.id
    );
    return { success: true, elemento: present(db.prepare('SELECT * FROM media_entries WHERE id = ?').get(row.id)) };
  },

  remove_media({ id, title, category }) {
    const row = findEntry({ id, title, category });
    db.prepare('DELETE FROM media_entries WHERE id = ?').run(row.id);
    return { success: true, eliminato: row.title };
  }
};
