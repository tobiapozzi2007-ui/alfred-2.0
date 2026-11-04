import fetch from 'node-fetch';

export const tools = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Ottieni le previsioni meteo attuali per una città.",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string", description: "Nome della città (es. Milano, Roma)" }
        },
        required: ["city"]
      }
    }
  }
];

export const handlers = {
  get_weather: async ({ city }) => {
    try {
      const geoRes = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=it`);
      const geoData = await geoRes.json();
      if (!geoData.results?.length) return `Città non trovata: ${city}`;

      const { latitude, longitude, name } = geoData.results[0];
      const wRes = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current_weather=true`);
      const wData = await wRes.json();

      return `Meteo a ${name}: ${wData.current_weather.temperature}°C, Vento: ${wData.current_weather.windspeed} km/h.`;
    } catch (err) {
      return `Errore durante il recupero del meteo: ${err.message}`;
    }
  }
};
