
import db from '../utils/db.js';
import { addDays, addMonths, nowParts, weekday } from '../utils/time.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS expense_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    amount REAL NOT NULL,
    currency TEXT NOT NULL DEFAULT 'EUR',
    category TEXT NOT NULL DEFAULT 'altro',
    description TEXT,
    spent_on TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_expense_date ON expense_entries (spent_on);
`);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PERIODS = ['today', 'yesterday', 'week', 'last_week', 'month', 'last_month', 'year', 'all'];
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

function resolvePeriod({ period, from, to } = {}) {
  if (from || to) {
    if ((from && !DATE_RE.test(from)) || (to && !DATE_RE.test(to))) {
      throw new Error('Le date devono essere nel formato YYYY-MM-DD.');
    }
    return { from: from || '0000-01-01', to: to || '9999-12-31' };
  }

  const today = nowParts().date;
  const monthStart = `${today.slice(0, 8)}01`;
  const weekStart = addDays(today, -((weekday(today) + 6) % 7)); // settimana da lunedì

  switch (period || 'month') {
    case 'today':
      return { from: today, to: today };
    case 'yesterday': {
      const y = addDays(today, -1);
      return { from: y, to: y };
    }
    case 'week':
      return { from: weekStart, to: addDays(weekStart, 6) };
    case 'last_week':
      return { from: addDays(weekStart, -7), to: addDays(weekStart, -1) };
    case 'month':
      return { from: monthStart, to: addDays(addMonths(monthStart, 1), -1) };
    case 'last_month':
      return { from: addMonths(monthStart, -1), to: addDays(monthStart, -1) };
    case 'year':
      return { from: `${today.slice(0, 4)}-01-01`, to: `${today.slice(0, 4)}-12-31` };
    case 'all':
      return { from: '0000-01-01', to: '9999-12-31' };
    default:
      throw new Error(`Periodo non valido. Valori ammessi: ${PERIODS.join(', ')}.`);
  }
}

function parseAmount(value) {
  const n = Number(String(value).replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0) throw new Error('L\'importo deve essere un numero maggiore di zero.');
  return round2(n);
}

const normCategory = (c) => String(c || 'altro').trim().toLowerCase() || 'altro';

const periodProps = {
  period: {
    type: 'string',
    enum: PERIODS,
    description: 'Periodo predefinito (default "month" = mese in corso). Ignorato se si indicano from/to.'
  },
  from: { type: 'string', description: 'Data iniziale "YYYY-MM-DD" (opzionale).' },
  to: { type: 'string', description: 'Data finale "YYYY-MM-DD" inclusa (opzionale).' }
};

export const tools = [
  {
    type: 'function',
    function: {
      name: 'add_expense',
      description:
        'Registra una spesa dell\'utente (importo, descrizione, categoria come cibo, trasporti, casa, svago, salute, abbonamenti, shopping, altro). Usalo anche quando l\'utente invia la foto di uno scontrino: leggi importo, negozio e data dall\'immagine.',
      parameters: {
        type: 'object',
        properties: {
          amount: { type: 'number', description: 'Importo positivo.' },
          description: { type: 'string', description: 'Cosa è stato acquistato o dove.' },
          category: { type: 'string', description: 'Categoria (default "altro").' },
          date: { type: 'string', description: 'Data della spesa "YYYY-MM-DD" (default oggi).' },
          currency: { type: 'string', description: 'Valuta (default EUR).' }
        },
        required: ['amount', 'description']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_expenses',
      description: 'Elenca le spese registrate in un periodo, eventualmente filtrate per categoria.',
      parameters: {
        type: 'object',
        properties: {
          ...periodProps,
          category: { type: 'string', description: 'Filtra per categoria (opzionale).' },
          limit: { type: 'integer', description: 'Numero massimo di righe (default 30, massimo 200).' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'expense_summary',
      description:
        'Riepilogo delle spese in un periodo: totale, numero di spese, totale per categoria e spesa più alta. Per confrontare due periodi chiamalo due volte.',
      parameters: { type: 'object', properties: { ...periodProps } }
    }
  },
  {
    type: 'function',
    function: {
      name: 'update_expense',
      description: 'Corregge una spesa esistente tramite id (importo, descrizione, categoria o data).',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          amount: { type: 'number' },
          description: { type: 'string' },
          category: { type: 'string' },
          date: { type: 'string', description: '"YYYY-MM-DD"' }
        },
        required: ['id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_expense',
      description: 'Elimina una spesa tramite id.',
      parameters: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] }
    }
  }
];

export const handlers = {
  add_expense({ amount, description, category, date, currency = 'EUR' }) {
    const value = parseAmount(amount);
    const day = date ? String(date).trim() : nowParts().date;
    if (!DATE_RE.test(day)) throw new Error('Data non valida: usa YYYY-MM-DD.');

    const info = db
      .prepare(
        'INSERT INTO expense_entries (amount, currency, category, description, spent_on) VALUES (?, ?, ?, ?, ?)'
      )
      .run(value, String(currency).toUpperCase(), normCategory(category), String(description).trim(), day);

    return {
      success: true,
      id: Number(info.lastInsertRowid),
      importo: value,
      valuta: String(currency).toUpperCase(),
      categoria: normCategory(category),
      data: day
    };
  },

  list_expenses({ category, limit = 30, ...period } = {}) {
    const { from, to } = resolvePeriod(period);
    const where = ['spent_on BETWEEN ? AND ?'];
    const params = [from, to];
    if (category) {
      where.push('category = ?');
      params.push(normCategory(category));
    }
    const cap = Math.min(Math.max(parseInt(limit, 10) || 30, 1), 200);

    const rows = db
      .prepare(
        `SELECT id, spent_on, amount, currency, category, description FROM expense_entries
         WHERE ${where.join(' AND ')} ORDER BY spent_on DESC, id DESC LIMIT ${cap}`
      )
      .all(...params);
    const total = db
      .prepare(`SELECT COALESCE(SUM(amount), 0) AS t, COUNT(*) AS n FROM expense_entries WHERE ${where.join(' AND ')}`)
      .get(...params);

    return {
      periodo: { da: from, a: to },
      totale_periodo: round2(total.t),
      numero_spese_periodo: total.n,
      mostrate: rows.length,
      spese: rows.map((r) => ({
        id: r.id,
        data: r.spent_on,
        importo: r.amount,
        valuta: r.currency,
        categoria: r.category,
        descrizione: r.description
      }))
    };
  },

  expense_summary(period = {}) {
    const { from, to } = resolvePeriod(period);
    const total = db
      .prepare('SELECT COALESCE(SUM(amount), 0) AS t, COUNT(*) AS n FROM expense_entries WHERE spent_on BETWEEN ? AND ?')
      .get(from, to);
    const byCategory = db
      .prepare(
        `SELECT category, ROUND(SUM(amount), 2) AS totale, COUNT(*) AS numero
         FROM expense_entries WHERE spent_on BETWEEN ? AND ? GROUP BY category ORDER BY SUM(amount) DESC`
      )
      .all(from, to);
    const biggest = db
      .prepare(
        `SELECT id, spent_on, amount, category, description FROM expense_entries
         WHERE spent_on BETWEEN ? AND ? ORDER BY amount DESC LIMIT 1`
      )
      .get(from, to);

    return {
      periodo: { da: from, a: to },
      totale: round2(total.t),
      numero_spese: total.n,
      per_categoria: byCategory.map((c) => ({
        categoria: c.category,
        totale: c.totale,
        numero: c.numero,
        percentuale: total.t > 0 ? Math.round((c.totale / total.t) * 100) : 0
      })),
      spesa_maggiore: biggest
        ? {
            id: biggest.id,
            data: biggest.spent_on,
            importo: biggest.amount,
            categoria: biggest.category,
            descrizione: biggest.description
          }
        : null,
      nota_valuta: 'I totali sommano gli importi così come registrati, senza conversioni di valuta.'
    };
  },

  update_expense({ id, amount, description, category, date }) {
    const row = db.prepare('SELECT * FROM expense_entries WHERE id = ?').get(Number(id));
    if (!row) return { success: false, error: `Nessuna spesa con id ${id}.` };

    const next = {
      amount: amount !== undefined ? parseAmount(amount) : row.amount,
      description: description !== undefined ? String(description).trim() : row.description,
      category: category !== undefined ? normCategory(category) : row.category,
      spent_on: date !== undefined ? String(date).trim() : row.spent_on
    };
    if (!DATE_RE.test(next.spent_on)) throw new Error('Data non valida: usa YYYY-MM-DD.');

    db.prepare('UPDATE expense_entries SET amount = ?, description = ?, category = ?, spent_on = ? WHERE id = ?').run(
      next.amount,
      next.description,
      next.category,
      next.spent_on,
      row.id
    );
    return { success: true, id: row.id, importo: next.amount, categoria: next.category, data: next.spent_on };
  },

  delete_expense({ id }) {
    const info = db.prepare('DELETE FROM expense_entries WHERE id = ?').run(Number(id));
    return { success: info.changes > 0, eliminate: info.changes };
  }
};
