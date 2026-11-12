import db from '../utils/db.js';
import { formatTime, nowParts, TIMEZONE } from '../utils/time.js';
// Gli avvisi sugli impegni leggono il calendario riusando il modulo calendar.js
import * as calendar from './calendar.js';

/* ------------------------------------------------------------------ */
/*  Impostazioni salvate nel database                                  */
/* ------------------------------------------------------------------ */

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS event_alerts (
    event_key TEXT PRIMARY KEY,
    alerted_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

const DEFAULTS = {
  briefing_enabled: '1',
  briefing_time: process.env.BRIEFING_TIME || '07:00',
  event_alert_minutes: process.env.EVENT_ALERT_MINUTES || '60'
};

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : DEFAULTS[key] ?? null;
}

function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    String(value)
  );
}

const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/* ------------------------------------------------------------------ */
/*  Istruzioni del briefing                                            */
/* ------------------------------------------------------------------ */

const BRIEFING_PROMPT = [
  'Prepara il briefing per l\'utente per la giornata di oggi.',
  'Con gli strumenti a tua disposizione raccogli, nell\'ordine:',
  '1) gli impegni di oggi;',
  '2) i promemoria in scadenza oggi;',
  '3) il meteo di oggi nella città dell\'utente: cerca la città con gli strumenti di memoria e, se davvero non la trovi, chiedila all\'utente in una riga finale invece di saltare la parte;',
  '4) le abitudini o attività che l\'utente vuole svolgere oggi, se hai strumenti per leggerle;',
  '5) le email importanti arrivate di recente, se hai strumenti per leggerle;',
  '6) le notizie principali che interessano all\'utente, se hai strumenti per leggerle.',
  'Salta senza menzionarle le parti per cui non hai strumenti o non trovi dati. Se non ci sono impegni dillo con piacere.',
  'Scrivi un unico messaggio ordinato e discorsivo, che apre con un saluto adatto al momento della giornata e usa se serve brevi paragrafi separati. Aggiungi un suggerimento pratico solo se è davvero utile (ad esempio ombrello in caso di pioggia, o partire prima per un impegno lontano).'
].join('\n');

/* ------------------------------------------------------------------ */
/*  Tool                                                               */
/* ------------------------------------------------------------------ */

export const tools = [
  {
    type: 'function',
    function: {
      name: 'get_briefing',
      description:
        'Da usare quando l\'utente chiede il briefing, il riepilogo della giornata o "cosa c\'è oggi". Restituisce le istruzioni su cosa raccogliere: segui quelle istruzioni usando gli altri strumenti e poi scrivi il briefing.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_proactive_settings',
      description:
        'Mostra le impostazioni dei messaggi automatici: orario del briefing mattutino, se è attivo e quanti minuti prima di un impegno arriva l\'avviso.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'update_proactive_settings',
      description:
        'Modifica le impostazioni dei messaggi automatici. Si può cambiare l\'orario del briefing mattutino, attivarlo o disattivarlo, e l\'anticipo in minuti dell\'avviso prima degli impegni del calendario (0 per disattivarlo).',
      parameters: {
        type: 'object',
        properties: {
          briefing_time: { type: 'string', description: 'Orario del briefing nel formato "HH:MM" (24 ore).' },
          briefing_enabled: { type: 'boolean', description: 'true per attivare il briefing, false per disattivarlo.' },
          event_alert_minutes: {
            type: 'integer',
            description: 'Minuti di anticipo dell\'avviso prima di un impegno (da 0 a 1440, 0 = nessun avviso).'
          }
        }
      }
    }
  }
];

function currentSettings() {
  return {
    briefing_attivo: getSetting('briefing_enabled') === '1',
    briefing_orario: getSetting('briefing_time'),
    avviso_impegni_minuti_prima: Number(getSetting('event_alert_minutes')),
    fuso_orario: TIMEZONE
  };
}

export const handlers = {
  get_briefing() {
    return { istruzioni: BRIEFING_PROMPT };
  },

  get_proactive_settings() {
    return currentSettings();
  },

  update_proactive_settings({ briefing_time, briefing_enabled, event_alert_minutes } = {}) {
    if (briefing_time !== undefined) {
      const m = TIME_RE.exec(String(briefing_time).trim());
      if (!m) return { success: false, error: 'Orario non valido: usa il formato HH:MM.' };
      setSetting('briefing_time', `${m[1].padStart(2, '0')}:${m[2]}`);
    }
    if (briefing_enabled !== undefined) {
      setSetting('briefing_enabled', briefing_enabled ? '1' : '0');
    }
    if (event_alert_minutes !== undefined) {
      const n = Math.round(Number(event_alert_minutes));
      if (!Number.isFinite(n) || n < 0 || n > 1440) {
        return { success: false, error: 'I minuti devono essere un numero tra 0 e 1440.' };
      }
      setSetting('event_alert_minutes', n);
    }
    return { success: true, impostazioni: currentSettings() };
  }
};

/* ------------------------------------------------------------------ */
/*  Attività automatiche (avviate da ai.js tramite l'hook init)        */
/* ------------------------------------------------------------------ */

const TICK_MS = 60_000;
const EVENT_CHECK_EVERY_MS = 120_000;
const BRIEFING_GRACE_MINUTES = 180; // se il NAS era spento alle 7:00, lo invia comunque entro 3 ore

function buildEventPrompt(ev, minutes) {
  const when = formatTime(new Date(ev.inizio));
  const details = [
    `titolo: "${ev.titolo}"`,
    `inizio: ${when}`,
    ev.luogo ? `luogo: ${ev.luogo}` : 'luogo: non indicato',
    ev.descrizione ? `note: ${ev.descrizione}` : null
  ]
    .filter(Boolean)
    .join('; ');

  return [
    `Tra circa ${minutes} minuti l'utente ha questo impegno nel calendario (${details}).`,
    'Scrivi un avviso breve e utile.',
    'In base al tipo di impegno aggiungi uno o due suggerimenti concreti: se si svolge all\'aperto o richiede uno spostamento, controlla con gli strumenti il meteo previsto nel luogo dell\'impegno (o nella città dell\'utente se il luogo manca) e consiglia di conseguenza; se c\'è un luogo, ricorda di calcolare il tempo di spostamento; per riunioni, appuntamenti o scadenze suggerisci cosa preparare.',
    'Non inventare dati: verifica con gli strumenti e, se un suggerimento non serve, non aggiungerlo.'
  ].join('\n');
}

export function init(ctx) {
  let busy = false;
  let lastEventCheck = 0;

  const maybeSendBriefing = async () => {
    if (getSetting('briefing_enabled') !== '1') return;

    const m = TIME_RE.exec(getSetting('briefing_time') || '');
    if (!m) return;

    const target = Number(m[1]) * 60 + Number(m[2]);
    const now = nowParts();
    if (now.minutes < target || now.minutes >= target + BRIEFING_GRACE_MINUTES) return;
    if (getSetting('last_briefing_date') === now.date) return;

    // Segna prima di generare: niente doppi invii anche se qualcosa va storto
    setSetting('last_briefing_date', now.date);
    const text = await ctx.runTask(BRIEFING_PROMPT);
    await ctx.notify(text);
  };

  const checkEventAlerts = async () => {
    const lead = Number(getSetting('event_alert_minutes'));
    if (!lead || lead < 1) return;
    if (Date.now() - lastEventCheck < EVENT_CHECK_EVERY_MS) return;
    lastEventCheck = Date.now();

    const now = new Date();
    const until = new Date(now.getTime() + lead * 60_000);
    const res = await calendar.handlers.get_calendar_events({
      start_date: now.toISOString(),
      end_date: until.toISOString(),
      max_results: 20
    });
    if (res.error) {
      console.error('[proactive] Calendario:', res.error);
      return;
    }

    for (const ev of res.eventi || []) {
      if (ev.tutto_il_giorno) continue;
      const start = new Date(ev.inizio);
      if (isNaN(start.getTime()) || start <= now) continue; // già iniziato

      const key = `${ev.id}|${ev.inizio}`;
      if (db.prepare('SELECT 1 FROM event_alerts WHERE event_key = ?').get(key)) continue;
      db.prepare('INSERT INTO event_alerts (event_key) VALUES (?)').run(key);

      const minutes = Math.max(1, Math.round((start - now) / 60_000));
      try {
        const text = await ctx.runTask(buildEventPrompt(ev, minutes));
        await ctx.notify(text);
      } catch (err) {
        console.error(`[proactive] Errore nell'avviso per "${ev.titolo}":`, err.message);
      }
    }

    db.prepare("DELETE FROM event_alerts WHERE alerted_at < datetime('now', '-7 days')").run();
  };

  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await maybeSendBriefing();
    } catch (err) {
      console.error('[proactive] Errore nel briefing:', err.message);
    }
    try {
      await checkEventAlerts();
    } catch (err) {
      console.error('[proactive] Errore negli avvisi:', err.message);
    } finally {
      busy = false;
    }
  };

  setInterval(tick, TICK_MS);
  tick();
  console.log(
    `[proactive] Attivo: briefing alle ${getSetting('briefing_time')}, avvisi ${getSetting('event_alert_minutes')} minuti prima.`
  );
}
