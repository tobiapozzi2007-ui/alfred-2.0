import db from '../utils/db.js';
import {
  addDays,
  addMonths,
  formatLocal,
  localString,
  parseLocal,
  weekday,
  zonedToUtc,
  TIMEZONE
} from '../utils/time.js';

/* ------------------------------------------------------------------ */
/*  Database                                                           */
/* ------------------------------------------------------------------ */

db.exec(`
  CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message TEXT NOT NULL,
    due_local TEXT NOT NULL,
    due_utc INTEGER NOT NULL,
    recurrence TEXT NOT NULL DEFAULT 'none',
    as_task INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders (active, due_utc);
`);

const RECURRENCES = ['none', 'daily', 'weekdays', 'weekly', 'monthly'];
const RECURRENCE_LABEL = {
  none: 'una volta',
  daily: 'ogni giorno',
  weekdays: 'dal lunedì al venerdì',
  weekly: 'ogni settimana',
  monthly: 'ogni mese'
};

/* ------------------------------------------------------------------ */
/*  Calcolo della prossima scadenza                                    */
/* ------------------------------------------------------------------ */

function nextLocal(dueLocal, recurrence) {
  const [datePart, timePart] = dueLocal.split('T');
  let next = datePart;

  switch (recurrence) {
    case 'daily':
      next = addDays(datePart, 1);
      break;
    case 'weekdays':
      do {
        next = addDays(next, 1);
      } while (weekday(next) === 0 || weekday(next) === 6);
      break;
    case 'weekly':
      next = addDays(datePart, 7);
      break;
    case 'monthly':
      next = addMonths(datePart, 1);
      break;
    default:
      return null;
  }
  return `${next}T${timePart}`;
}

function localToUtcMs(dueLocal) {
  const p = parseLocal(dueLocal);
  return zonedToUtc(p.y, p.mo, p.d, p.h, p.mi, p.s).getTime();
}

/* ------------------------------------------------------------------ */
/*  Tool                                                               */
/* ------------------------------------------------------------------ */

export const tools = [
  {
    type: 'function',
    function: {
      name: 'set_reminder',
      description:
        'Programma un promemoria: a quell\'ora Alfred scrive all\'utente di sua iniziativa. Può essere singolo o ricorrente. Con as_task=true, all\'ora indicata Alfred esegue il testo come un\'istruzione usando i suoi strumenti (es. "dimmi il meteo di oggi e gli impegni") invece di limitarsi a ripeterlo.',
      parameters: {
        type: 'object',
        properties: {
          message: {
            type: 'string',
            description: 'Testo del promemoria (o istruzione da eseguire se as_task è true).'
          },
          when: {
            type: 'string',
            description: 'Data e ora locali della prima scadenza, formato "YYYY-MM-DDTHH:MM:SS".'
          },
          recurrence: {
            type: 'string',
            enum: RECURRENCES,
            description: 'Ripetizione: none (default), daily, weekdays (lun-ven), weekly, monthly.'
          },
          as_task: {
            type: 'boolean',
            description: 'Se true, alla scadenza Alfred esegue il testo come istruzione. Default false.'
          }
        },
        required: ['message', 'when']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_reminders',
      description: 'Elenca i promemoria attivi (con id, prossima scadenza e ripetizione).',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_reminder',
      description: 'Elimina un promemoria tramite il suo id (ottenibile con list_reminders).',
      parameters: {
        type: 'object',
        properties: { id: { type: 'integer', description: 'Id del promemoria.' } },
        required: ['id']
      }
    }
  }
];

export const handlers = {
  set_reminder({ message, when, recurrence = 'none', as_task = false }) {
    if (!message || !String(message).trim()) return { success: false, error: 'Testo mancante.' };

    const parsed = parseLocal(when);
    if (!parsed) {
      return { success: false, error: 'Formato data/ora non valido: serve "YYYY-MM-DDTHH:MM:SS" (ora locale).' };
    }
    if (!RECURRENCES.includes(recurrence)) {
      return { success: false, error: `Ripetizione non valida. Valori ammessi: ${RECURRENCES.join(', ')}.` };
    }

    const dueLocal = localString(parsed);
    const dueUtc = localToUtcMs(dueLocal);

    if (recurrence === 'none' && dueUtc < Date.now() - 60_000) {
      return { success: false, error: 'Quell\'orario è già passato.' };
    }

    const info = db
      .prepare('INSERT INTO reminders (message, due_local, due_utc, recurrence, as_task) VALUES (?, ?, ?, ?, ?)')
      .run(String(message).trim(), dueLocal, dueUtc, recurrence, as_task ? 1 : 0);

    return {
      success: true,
      id: Number(info.lastInsertRowid),
      scadenza: formatLocal(new Date(dueUtc)),
      ripetizione: RECURRENCE_LABEL[recurrence],
      eseguito_come_istruzione: Boolean(as_task)
    };
  },

  list_reminders() {
    const rows = db
      .prepare('SELECT id, message, due_utc, recurrence, as_task FROM reminders WHERE active = 1 ORDER BY due_utc ASC')
      .all();
    return {
      totale: rows.length,
      promemoria: rows.map((r) => ({
        id: r.id,
        testo: r.message,
        prossima_scadenza: formatLocal(new Date(r.due_utc)),
        ripetizione: RECURRENCE_LABEL[r.recurrence] || r.recurrence,
        eseguito_come_istruzione: Boolean(r.as_task)
      }))
    };
  },

  delete_reminder({ id }) {
    const info = db.prepare('DELETE FROM reminders WHERE id = ?').run(Number(id));
    return { success: info.changes > 0, eliminati: info.changes };
  }
};

/* ------------------------------------------------------------------ */
/*  Scheduler (avviato da ai.js tramite l'hook init)                   */
/* ------------------------------------------------------------------ */

const TICK_MS = 30_000;

export function init(ctx) {
  let busy = false;

  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const due = db
        .prepare('SELECT * FROM reminders WHERE active = 1 AND due_utc <= ? ORDER BY due_utc ASC')
        .all(Date.now());

      for (const r of due) {
        // Aggiorna PRIMA di inviare: al massimo una consegna, niente ripetizioni in caso di errore
        if (r.recurrence === 'none') {
          db.prepare('UPDATE reminders SET active = 0 WHERE id = ?').run(r.id);
        } else {
          let nextLocalStr = r.due_local;
          let nextUtc = r.due_utc;
          for (let i = 0; i < 1000 && nextUtc <= Date.now(); i++) {
            nextLocalStr = nextLocal(nextLocalStr, r.recurrence);
            nextUtc = localToUtcMs(nextLocalStr);
          }
          db.prepare('UPDATE reminders SET due_local = ?, due_utc = ? WHERE id = ?').run(nextLocalStr, nextUtc, r.id);
        }

        try {
          if (r.as_task) {
            const text = await ctx.runTask(r.message);
            await ctx.notify(text);
          } else {
            await ctx.notify(`⏰ Promemoria: ${r.message}`);
          }
        } catch (err) {
          console.error(`[reminders] Errore nell'invio del promemoria ${r.id}:`, err.message);
        }
      }
    } catch (err) {
      console.error('[reminders] Errore nel controllo:', err);
    } finally {
      busy = false;
    }
  };

  setInterval(tick, TICK_MS);
  tick(); // recupera subito eventuali promemoria scaduti mentre il NAS era spento
  console.log(`[reminders] Scheduler attivo (fuso ${TIMEZONE}).`);
}
