import { google } from 'googleapis';

const calendar = google.calendar('v3');

const getAuth = () => {
  if (!process.env.GOOGLE_CREDENTIALS) return null;
  try {
    const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
    const auth = google.auth.fromJSON(credentials);
    auth.scopes = ['https://www.googleapis.com/auth/calendar'];
    return auth;
  } catch (err) {
    console.error("Errore nel parsing di GOOGLE_CREDENTIALS:", err.message);
    return null;
  }
};

// Usa l'email utente dal .env oppure 'primary'
const getTargetCalendarId = () => {
  return process.env.EMAIL_USER || 'primary';
};

export const tools = [
  {
    type: "function",
    function: {
      name: "add_calendar_event",
      description: "Aggiunge un nuovo evento o appuntamento al Google Calendar.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "Titolo dell'evento" },
          startTime: { type: "string", description: "Data e ora di inizio in formato ISO (es. 2026-11-04T15:00:00Z)" },
          endTime: { type: "string", description: "Data e ora di fine in formato ISO (es. 2026-11-04T16:00:00Z)" },
          description: { type: "string", description: "Descrizione o note aggiuntive dell'evento" }
        },
        required: ["summary", "startTime", "endTime"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_calendar_events",
      description: "Legge ed elenca gli impegni dal Google Calendar dell'utente.",
      parameters: {
        type: "object",
        properties: {
          timeMin: { type: "string", description: "Data e ora inizio ricerca ISO 8601 (opzionale, default inizio giornata odierna)" },
          timeMax: { type: "string", description: "Data e ora fine ricerca ISO 8601 (opzionale, default fine giornata odierna)" }
        }
      }
    }
  }
];

export const handlers = {
  add_calendar_event: async ({ summary, startTime, endTime, description }) => {
    const auth = getAuth();
    if (!auth) return "Credenziali GOOGLE_CREDENTIALS mancanti o non valide nel file .env.";

    try {
      const res = await calendar.events.insert({
        auth,
        calendarId: getTargetCalendarId(),
        requestBody: {
          summary,
          description: description || '',
          start: { dateTime: startTime },
          end: { dateTime: endTime }
        }
      });
      return `Evento "${summary}" inserito con successo nel calendario!`;
    } catch (err) {
      console.error("Errore inserimento evento:", err);
      return `Errore durante la creazione dell'evento: ${err.message}`;
    }
  },

  get_calendar_events: async ({ timeMin, timeMax }) => {
    const auth = getAuth();
    if (!auth) return "Credenziali GOOGLE_CREDENTIALS mancanti o non valide nel file .env.";

    try {
      const now = new Date();
      // Calcolo default: inizio giornata (00:00) e fine giornata (23:59) se l'IA non specifica date
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
      const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);

      const minIso = timeMin ? new Date(timeMin).toISOString() : startOfDay.toISOString();
      const maxIso = timeMax ? new Date(timeMax).toISOString() : endOfDay.toISOString();

      const res = await calendar.events.list({
        auth,
        calendarId: getTargetCalendarId(),
        timeMin: minIso,
        timeMax: maxIso,
        singleEvents: true,
        orderBy: 'startTime',
      });

      const events = res.data.items;
      if (!events || events.length === 0) {
        return "Nessun evento o impegno trovato sul tuo Google Calendar nell'intervallo di tempo richiesto.";
      }

      const formattedEvents = events.map(event => ({
        titolo: event.summary || 'Senza titolo',
        inizio: event.start.dateTime || event.start.date,
        fine: event.end.dateTime || event.end.date,
        descrizione: event.description || '',
        luogo: event.location || ''
      }));

      return JSON.stringify(formattedEvents);
    } catch (err) {
      console.error("Errore lettura calendario:", err);
      return `Errore nella lettura del calendario: ${err.message}`;
    }
  }
};
