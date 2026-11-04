import { google } from 'googleapis';

const calendar = google.calendar('v3');

// Inizializzazione OAuth2 usabile con Service Account o token salvato
const getAuth = () => {
  if (!process.env.GOOGLE_REFRESH_TOKEN) return null;
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return auth;
};

export const tools = [
  {
    type: "function",
    function: {
      name: "add_calendar_event",
      description: "Aggiunge un evento al Google Calendar.",
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
    if (!auth) return "Credenziali Google Calendar non configurate nel file .env.";

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
