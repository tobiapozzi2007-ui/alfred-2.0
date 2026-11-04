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

export const tools = [
  {
    type: "function",
    function: {
      name: "add_calendar_event",
      description: "Aggiunge un nuovo evento al Google Calendar.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "Titolo dell'evento" },
          startTime: { type: "string", description: "Data e ora inizio in formato ISO (es. 2026-11-04T15:00:00Z)" },
          endTime: { type: "string", description: "Data e ora fine in formato ISO" }
        },
        required: ["summary", "startTime", "endTime"]
      }
    }
  }
];

export const handlers = {
  add_calendar_event: async ({ summary, startTime, endTime }) => {
    const auth = getAuth();
    if (!auth) return "Credenziali GOOGLE_CREDENTIALS mancanti o non valide nel file .env.";

    try {
      const res = await calendar.events.insert({
        auth,
        calendarId: 'primary',
        requestBody: {
          summary,
          start: { dateTime: startTime },
          end: { dateTime: endTime }
        }
      });
      return `Evento "${summary}" creato con successo! Link: ${res.data.htmlLink}`;
    } catch (err) {
      return `Errore durante la creazione dell'evento: ${err.message}`;
    }
  }
};
