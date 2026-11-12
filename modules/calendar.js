import { google } from 'googleapis';
import { addDays, addMonths, nowParts, weekday } from '../utils/time.js';

const TIMEZONE = process.env.BOT_TIMEZONE || 'Europe/Rome';
const SCOPES = ['https://www.googleapis.com/auth/calendar'];

/* ------------------------------------------------------------------ */
/*  Autenticazione (Service Account)                                   */
/* ------------------------------------------------------------------ */

let calendarClient = null;

function getCalendar() {
  if (calendarClient) return calendarClient;

  if (!process.env.GOOGLE_CREDENTIALS) {
    throw new Error('GOOGLE_CREDENTIALS non configurato nel file .env.');
  }

  const auth = google.auth.fromJSON(JSON.parse(process.env.GOOGLE_CREDENTIALS));
  auth.scopes = SCOPES;

  calendarClient = google.calendar({ version: 'v3', auth });
  return calendarClient;
}

// Calendario personale condiviso con il Service Account
const getCalendarId = () => process.env.EMAIL_USER || 'primary';

/* ------------------------------------------------------------------ */
/*  Utilità per date e fusi orari                                      */
/* ------------------------------------------------------------------ */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_DATETIME = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

function tzOffsetMs(date, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
    .formatToParts(date)
    .reduce((acc, p) => {
      acc[p.type] = p.value;
      return acc;
    }, {});

  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

// Converte una data/ora "a muro" nel fuso indicato in un istante UTC
function zonedToUtc(y, mo, d, h, mi, s, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const firstPass = guess - tzOffsetMs(new Date(guess), tz);
  return new Date(guess - tzOffsetMs(new Date(firstPass), tz));
}

function todayInTz(tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date()); // YYYY-MM-DD
}

function addDaysToDateString(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function parseBoundary(value, isEnd) {
  const text = String(value).trim();
  const m = LOCAL_DATETIME.exec(text);

  if (m) {
    const [, y, mo, d, h, mi, s] = m;
    if (h === undefined) {
      // Solo data: inizio giornata, oppure fine giornata se è il limite finale
      const day = isEnd ? addDaysToDateString(text, 1) : text;
      const [yy, mm, dd] = day.split('-').map(Number);
      return zonedToUtc(yy, mm, dd, 0, 0, 0, TIMEZONE);
    }
    return zonedToUtc(+y, +mo, +d, +h, +mi, +(s || 0), TIMEZONE);
  }

  const parsed = new Date(text); // formati con offset, es. 2026-11-05T10:00:00+01:00
  if (isNaN(parsed.getTime())) throw new Error(`Data non valida: "${value}"`);
  return parsed;
}

// Aggiunge ore a un datetime ISO, mantenendo il formato (locale oppure con offset)
function addHours(value, hours) {
  const m = LOCAL_DATETIME.exec(value);
  if (m && m[4] !== undefined) {
    const [, y, mo, d, h, mi, s] = m;
    const t = new Date(Date.UTC(+y, +mo - 1, +d, +h + hours, +mi, +(s || 0)));
    return t.toISOString().slice(0, 19);
  }
  const t = new Date(value);
  if (isNaN(t.getTime())) throw new Error(`Data/ora non valida: "${value}"`);
  return new Date(t.getTime() + hours * 3600_000).toISOString();
}

/* ------------------------------------------------------------------ */
/*  Periodi predefiniti e date leggibili                               */
/* ------------------------------------------------------------------ */

// "YYYY-MM-DD" -> "lunedì 9 novembre 2026"
function formatDay(dateStr, withYear = true) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  return d.toLocaleDateString('it-IT', {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    ...(withYear ? { year: 'numeric' } : {})
  });
}

function resolvePeriod(period) {
  const today = nowParts().date;
  const monthStart = `${today.slice(0, 8)}01`;
  const weekStart = addDays(today, -((weekday(today) + 6) % 7)); // settimana da lunedì

  switch (period) {
    case 'today':
      return { from: today, to: today };
    case 'tomorrow': {
      const t = addDays(today, 1);
      return { from: t, to: t };
    }
    case 'this_week':
      return { from: weekStart, to: addDays(weekStart, 6) };
    case 'next_7_days':
      return { from: today, to: addDays(today, 6) };
    case 'this_month':
      return { from: monthStart, to: addDays(addMonths(monthStart, 1), -1) };
    default:
      throw new Error('Periodo non valido. Valori ammessi: today, tomorrow, this_week, next_7_days, this_month.');
  }
}

// Giorno e ora già scritti in italiano, così non devono essere ricalcolati a mano
function describeWhen(ev) {
  if (ev.start?.date) {
    const end = ev.end?.date ? addDays(ev.end.date, -1) : ev.start.date; // la fine su Google è esclusiva
    return end > ev.start.date
      ? `da ${formatDay(ev.start.date, false)} a ${formatDay(end, false)} (tutto il giorno)`
      : `${formatDay(ev.start.date, false)} (tutto il giorno)`;
  }
  const start = new Date(ev.start?.dateTime);
  if (isNaN(start.getTime())) return null;

  const day = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE }).format(start); // YYYY-MM-DD locale
  const time = (d) => d.toLocaleTimeString('it-IT', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit' });
  const end = ev.end?.dateTime ? new Date(ev.end.dateTime) : null;
  return `${formatDay(day, false)}, ${time(start)}${end && !isNaN(end.getTime()) ? `–${time(end)}` : ''}`;
}

/* ------------------------------------------------------------------ */
/*  Tool                                                               */
/* ------------------------------------------------------------------ */

export const tools = [
  {
    type: 'function',
    function: {
      name: 'add_calendar_event',
      description:
        'Crea un evento nel calendario Google dell\'utente. Per eventi con orario usa data e ora locali (es. "2026-11-05T15:30:00"); per eventi di un\'intera giornata usa solo la data (es. "2026-11-05").',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'Titolo dell\'evento.' },
          start: {
            type: 'string',
            description: 'Inizio: "YYYY-MM-DDTHH:MM:SS" (ora locale) oppure "YYYY-MM-DD" per tutto il giorno.'
          },
          end: {
            type: 'string',
            description:
              'Fine (stesso formato di start). Opzionale: se assente l\'evento dura 1 ora. Per eventi di tutto il giorno è l\'ultimo giorno incluso.'
          },
          description: { type: 'string', description: 'Descrizione o note (opzionale).' },
          location: { type: 'string', description: 'Luogo (opzionale).' }
        },
        required: ['summary', 'start']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_calendar_events',
      description:
        'Legge gli eventi del calendario Google dell\'utente. Per "oggi", "domani", "questa settimana" o "prossimi giorni" usa SEMPRE il parametro period e non calcolare le date da solo: il periodo viene calcolato con precisione dal sistema. Usa start_date e end_date solo per date precise indicate dall\'utente (es. "il 20 novembre"). Senza parametri restituisce gli eventi di oggi. Per ogni evento il campo "quando" contiene già giorno e ora scritti in italiano: usali così come sono.',
      parameters: {
        type: 'object',
        properties: {
          period: {
            type: 'string',
            enum: ['today', 'tomorrow', 'this_week', 'next_7_days', 'this_month'],
            description:
              'Periodo già calcolato dal sistema: today = oggi, tomorrow = domani, this_week = da lunedì a domenica della settimana in corso, next_7_days = da oggi per 7 giorni, this_month = mese in corso.'
          },
          start_date: {
            type: 'string',
            description: 'Inizio intervallo: "YYYY-MM-DD" o "YYYY-MM-DDTHH:MM:SS" (opzionale, default oggi).'
          },
          end_date: {
            type: 'string',
            description:
              'Fine intervallo, stesso formato (opzionale). Se è solo una data, include tutta quella giornata. Se assente si legge solo il giorno di start_date.'
          },
          max_results: {
            type: 'integer',
            description: 'Numero massimo di eventi (default 25, massimo 100).'
          }
        }
      }
    }
  }
];

export const handlers = {
  async add_calendar_event({ summary, start, end, description, location }) {
    if (!summary || !start) {
      return { success: false, error: 'Servono almeno titolo e data/ora di inizio.' };
    }

    const startStr = String(start).trim();
    const allDay = DATE_ONLY.test(startStr);
    let startField;
    let endField;

    if (allDay) {
      const lastDay = end && DATE_ONLY.test(String(end).trim()) ? String(end).trim() : startStr;
      startField = { date: startStr };
      endField = { date: addDaysToDateString(lastDay, 1) }; // la fine su Google è esclusiva
    } else {
      const endStr = end ? String(end).trim() : addHours(startStr, 1);
      startField = { dateTime: startStr, timeZone: TIMEZONE };
      endField = { dateTime: endStr, timeZone: TIMEZONE };
    }

    const requestBody = { summary: String(summary), start: startField, end: endField };
    if (description) requestBody.description = String(description);
    if (location) requestBody.location = String(location);

    const res = await getCalendar().events.insert({
      calendarId: getCalendarId(),
      requestBody
    });

    const ev = res.data;
    return {
      success: true,
      id: ev.id,
      titolo: ev.summary,
      inizio: ev.start?.dateTime || ev.start?.date,
      fine: ev.end?.dateTime || ev.end?.date,
      tutto_il_giorno: allDay,
      link: ev.htmlLink
    };
  },

  async get_calendar_events({ period, start_date, end_date, max_results = 25 } = {}) {
    // Un periodo predefinito vince su qualunque data scritta dal modello: così "oggi" è sempre oggi
    if (period) {
      const range = resolvePeriod(period);
      start_date = range.from;
      end_date = range.to;
    }

    const first = start_date ? String(start_date).trim() : todayInTz(TIMEZONE);
    const last = end_date ? String(end_date).trim() : DATE_ONLY.test(first) ? first : null;

    const timeMin = parseBoundary(first, false);
    const timeMax = last ? parseBoundary(last, true) : new Date(timeMin.getTime() + 24 * 3600_000);

    if (timeMax <= timeMin) {
      return { error: 'La data di fine deve essere successiva a quella di inizio.' };
    }

    const res = await getCalendar().events.list({
      calendarId: getCalendarId(),
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      timeZone: TIMEZONE,
      maxResults: Math.min(Math.max(parseInt(max_results, 10) || 25, 1), 100)
    });

    const events = (res.data.items || []).map((ev) => ({
      id: ev.id,
      titolo: ev.summary || '(senza titolo)',
      quando: describeWhen(ev),
      inizio: ev.start?.dateTime || ev.start?.date,
      fine: ev.end?.dateTime || ev.end?.date,
      tutto_il_giorno: Boolean(ev.start?.date),
      luogo: ev.location || null,
      descrizione: ev.description || null
    }));

    console.log(
      `[calendar] eventi da ${timeMin.toISOString()} a ${timeMax.toISOString()} (richiesta: ${start_date || '-'} → ${end_date || '-'}): ${events.length} trovati`
    );

    return {
      oggi_e: formatDay(nowParts().date),
      periodo_richiesto: period || null,
      intervallo: { da: timeMin.toISOString(), a: timeMax.toISOString(), fuso_orario: TIMEZONE },
      totale: events.length,
      eventi: events
    };
  }
};
