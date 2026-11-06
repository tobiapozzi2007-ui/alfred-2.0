// Utilità condivise per date e fusi orari (usate dai moduli che pianificano cose)

export const TIMEZONE = process.env.BOT_TIMEZONE || 'Europe/Rome';

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

export function tzOffsetMs(date, tz = TIMEZONE) {
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

// Data/ora "a muro" nel fuso indicato -> istante UTC
export function zonedToUtc(y, mo, d, h = 0, mi = 0, s = 0, tz = TIMEZONE) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const firstPass = guess - tzOffsetMs(new Date(guess), tz);
  return new Date(guess - tzOffsetMs(new Date(firstPass), tz));
}

// "YYYY-MM-DDTHH:MM[:SS]" (ora locale) -> { y, mo, d, h, mi, s } oppure null
export function parseLocal(text) {
  const m = LOCAL_RE.exec(String(text || '').trim());
  if (!m) return null;
  return { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +(m[6] || 0) };
}

export function pad(n) {
  return String(n).padStart(2, '0');
}

export function localString({ y, mo, d, h, mi, s }) {
  return `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(s)}`;
}

// Ora locale oppure ISO con offset -> Date
export function toUtcDate(text) {
  const local = parseLocal(text);
  if (local) return zonedToUtc(local.y, local.mo, local.d, local.h, local.mi, local.s);
  const date = new Date(String(text).trim());
  if (isNaN(date.getTime())) throw new Error(`Data/ora non valida: "${text}"`);
  return date;
}

// Data e ora correnti nel fuso locale
export function nowParts(date = new Date()) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
    .formatToParts(date)
    .reduce((acc, x) => {
      acc[x.type] = x.value;
      return acc;
    }, {});

  const hour = +p.hour;
  const minute = +p.minute;
  return { date: `${p.year}-${p.month}-${p.day}`, hour, minute, minutes: hour * 60 + minute };
}

export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// Aggiunge mesi mantenendo il giorno (limitato all'ultimo giorno del mese di arrivo)
export function addMonths(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 + n, Math.min(d, lastDay))).toISOString().slice(0, 10);
}

// 0 = domenica ... 6 = sabato
export function weekday(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function formatLocal(date) {
  return date.toLocaleString('it-IT', { timeZone: TIMEZONE, dateStyle: 'full', timeStyle: 'short' });
}

export function formatTime(date) {
  return date.toLocaleTimeString('it-IT', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit' });
}
