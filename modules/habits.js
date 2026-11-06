import db from '../utils/db.js';
import { addDays, nowParts, weekday } from '../utils/time.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS habit_defs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    description TEXT,
    target_per_week INTEGER NOT NULL DEFAULT 7,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS habit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    habit_id INTEGER NOT NULL,
    done_on TEXT NOT NULL,
    note TEXT,
    UNIQUE (habit_id, done_on)
  );
`);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/* ------------------------------------------------------------------ */
/*  Calcoli                                                            */
/* ------------------------------------------------------------------ */

const weekStartOf = (date) => addDays(date, -((weekday(date) + 6) % 7)); // lunedì

function datesOf(habitId) {
  return new Set(
    db
      .prepare('SELECT done_on FROM habit_logs WHERE habit_id = ?')
      .all(habitId)
      .map((r) => r.done_on)
  );
}

// Giorni consecutivi fino a oggi (se oggi non è ancora fatta si parte da ieri)
function currentStreak(dates, today) {
  let day = dates.has(today) ? today : addDays(today, -1);
  let n = 0;
  while (dates.has(day)) {
    n++;
    day = addDays(day, -1);
  }
  return n;
}

function longestStreak(dates) {
  const sorted = [...dates].sort();
  let best = 0;
  let run = 0;
  let prev = null;
  for (const d of sorted) {
    run = prev && addDays(prev, 1) === d ? run + 1 : 1;
    best = Math.max(best, run);
    prev = d;
  }
  return best;
}

function summarize(habit, today) {
  const dates = datesOf(habit.id);
  const ws = weekStartOf(today);
  let thisWeek = 0;
  for (let i = 0; i < 7; i++) if (dates.has(addDays(ws, i))) thisWeek++;

  const doneToday = dates.has(today);
  return {
    id: habit.id,
    nome: habit.name,
    descrizione: habit.description || null,
    obiettivo_settimanale: habit.target_per_week,
    fatta_oggi: doneToday,
    questa_settimana: `${thisWeek}/${habit.target_per_week}`,
    serie_giorni_consecutivi: currentStreak(dates, today),
    // da fare oggi se non è già fatta e l'obiettivo settimanale non è ancora raggiunto
    _da_fare_oggi: !doneToday && thisWeek < habit.target_per_week
  };
}

function findHabit(name) {
  const text = String(name || '').trim();
  if (!text) throw new Error('Serve il nome dell\'abitudine.');

  const exact = db.prepare('SELECT * FROM habit_defs WHERE name = ?').get(text);
  if (exact) return exact;

  const like = db.prepare('SELECT * FROM habit_defs WHERE name LIKE ?').all(`%${text}%`);
  if (like.length === 1) return like[0];

  const all = db.prepare('SELECT name FROM habit_defs ORDER BY name').all().map((r) => r.name);
  if (like.length > 1) {
    throw new Error(`Nome ambiguo, intendi una di queste? ${like.map((h) => h.name).join(', ')}`);
  }
  throw new Error(
    all.length ? `Abitudine "${text}" non trovata. Quelle esistenti: ${all.join(', ')}.` : 'Non ci sono ancora abitudini registrate.'
  );
}

/* ------------------------------------------------------------------ */
/*  Tool                                                               */
/* ------------------------------------------------------------------ */

export const tools = [
  {
    type: 'function',
    function: {
      name: 'add_habit',
      description:
        'Crea una nuova abitudine da tracciare (es. "palestra", "bere 2 litri d\'acqua", "leggere"). Si può indicare quante volte a settimana l\'utente vuole farla (default 7 = ogni giorno).',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Nome breve dell\'abitudine.' },
          description: { type: 'string', description: 'Dettagli opzionali.' },
          target_per_week: { type: 'integer', description: 'Volte a settimana (1-7, default 7).' }
        },
        required: ['name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'log_habit',
      description:
        'Segna un\'abitudine come fatta (default oggi, o in una data indicata). Con done=false toglie il segno di quel giorno.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Nome (anche parziale) dell\'abitudine.' },
          date: { type: 'string', description: '"YYYY-MM-DD" (default oggi).' },
          done: { type: 'boolean', description: 'true (default) per segnarla, false per annullare.' },
          note: { type: 'string', description: 'Nota opzionale.' }
        },
        required: ['name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_habits',
      description:
        'Elenca le abitudini con stato di oggi, avanzamento settimanale e serie di giorni consecutivi, più quali restano da fare oggi.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'habit_stats',
      description: 'Statistiche di un\'abitudine negli ultimi N giorni: percentuale di completamento, serie attuale e record.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          days: { type: 'integer', description: 'Giorni da considerare (default 30, massimo 365).' }
        },
        required: ['name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'remove_habit',
      description: 'Elimina un\'abitudine e tutto il suo storico.',
      parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }
    }
  }
];

export const handlers = {
  add_habit({ name, description, target_per_week = 7 }) {
    const clean = String(name || '').trim();
    if (!clean) return { success: false, error: 'Nome mancante.' };
    const target = Math.min(Math.max(parseInt(target_per_week, 10) || 7, 1), 7);

    const exists = db.prepare('SELECT id FROM habit_defs WHERE name = ?').get(clean);
    if (exists) return { success: false, error: `L'abitudine "${clean}" esiste già.` };

    const info = db
      .prepare('INSERT INTO habit_defs (name, description, target_per_week) VALUES (?, ?, ?)')
      .run(clean, description ? String(description).trim() : null, target);
    return { success: true, id: Number(info.lastInsertRowid), nome: clean, obiettivo_settimanale: target };
  },

  log_habit({ name, date, done = true, note }) {
    const habit = findHabit(name);
    const today = nowParts().date;
    const day = date ? String(date).trim() : today;
    if (!DATE_RE.test(day)) throw new Error('Data non valida: usa YYYY-MM-DD.');
    if (day > today) return { success: false, error: 'Non si possono segnare giorni futuri.' };

    if (done === false) {
      const info = db.prepare('DELETE FROM habit_logs WHERE habit_id = ? AND done_on = ?').run(habit.id, day);
      return { success: true, azione: 'annullata', abitudine: habit.name, data: day, rimossi: info.changes };
    }

    db.prepare(
      `INSERT INTO habit_logs (habit_id, done_on, note) VALUES (?, ?, ?)
       ON CONFLICT(habit_id, done_on) DO UPDATE SET note = COALESCE(excluded.note, habit_logs.note)`
    ).run(habit.id, day, note ? String(note).trim() : null);

    const { _da_fare_oggi, ...summary } = summarize(habit, today);
    return { success: true, azione: 'registrata', data: day, ...summary };
  },

  list_habits() {
    const today = nowParts().date;
    const habits = db.prepare('SELECT * FROM habit_defs ORDER BY name').all();
    const all = habits.map((h) => summarize(h, today));
    return {
      oggi: today,
      totale: all.length,
      da_fare_oggi: all.filter((h) => h._da_fare_oggi).map((h) => h.nome),
      abitudini: all.map(({ _da_fare_oggi, ...rest }) => rest)
    };
  },

  habit_stats({ name, days = 30 }) {
    const habit = findHabit(name);
    const span = Math.min(Math.max(parseInt(days, 10) || 30, 1), 365);
    const today = nowParts().date;
    const dates = datesOf(habit.id);

    // l'abitudine conta solo dal giorno in cui è stata creata
    const created = db.prepare("SELECT date(created_at) AS d FROM habit_defs WHERE id = ?").get(habit.id)?.d || today;
    const firstDay = addDays(today, -(span - 1));
    const start = created > firstDay ? created : firstDay;

    let counted = 0;
    let done = 0;
    for (let d = start; d <= today; d = addDays(d, 1)) {
      counted++;
      if (dates.has(d)) done++;
    }
    const last = [...dates].sort().pop() || null;

    return {
      abitudine: habit.name,
      obiettivo_settimanale: habit.target_per_week,
      giorni_considerati: counted,
      giorni_completati: done,
      percentuale: counted ? Math.round((done / counted) * 100) : 0,
      serie_attuale: currentStreak(dates, today),
      serie_record: longestStreak(dates),
      ultima_volta: last
    };
  },

  remove_habit({ name }) {
    const habit = findHabit(name);
    db.prepare('DELETE FROM habit_logs WHERE habit_id = ?').run(habit.id);
    db.prepare('DELETE FROM habit_defs WHERE id = ?').run(habit.id);
    return { success: true, eliminata: habit.name };
  }
};
