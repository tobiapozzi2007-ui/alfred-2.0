import fetch from 'node-fetch';

// Mappatura codici WMO in descrizioni in italiano
const weatherCodes = {
  0: "Sereno ☀️",
  1: "Prevalentemente sereno 🌤️",
  2: "Poco nuvoloso ⛅",
  3: "Coperto ☁️",
  45: "Nebbia 🌫️",
  48: "Nebbia con brina 🌫️",
  51: "Pioggerella leggera 🌧️",
  53: "Pioggerella moderata 🌧️",
  55: "Pioggerella fitta 🌧️",
  61: "Pioggia debole 🌧️",
  63: "Pioggia moderata 🌧️",
  65: "Pioggia forte 🌧️",
  71: "Neve debole ❄️",
  73: "Neve moderata ❄️",
  75: "Neve forte ❄️",
  80: "Rovesci di pioggia deboli 🌦️",
  81: "Rovesci di pioggia moderati 🌦️",
  82: "Rovesci di pioggia violenti 🌧️",
  95: "Temporale ⚡",
  96: "Temporale con grandine debole ⛈️",
  99: "Temporale con grandine forte ⛈️"
};

export const tools = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Ottieni previsioni meteo attuali o future (domani, prossimi giorni, temperature max/min, probabilità di pioggia, umidità e vento) per qualsiasi città.",
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
      // 1. Geocodifica della città
      const geoRes = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=it`);
      const geoData = await geoRes.json();
      if (!geoData.results?.length) return `Città non trovata: ${city}`;

      const { latitude, longitude, name } = geoData.results[0];

      // 2. Richiesta meteo dettagliato (attuale + previsioni giornaliere per 7 giorni)
      const wRes = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto`
      );
      const wData = await wRes.json();

      const current = wData.current;
      const daily = wData.daily;

      // Costruzione dell'oggetto con tutte le informazioni per l'IA
      const forecastInfo = {
        citta: name,
        meteo_attuale: {
          temperatura: `${current.temperature_2m}°C`,
          percepita: `${current.apparent_temperature}°C`,
          umidita: `${current.relative_humidity_2m}%`,
          condizione: weatherCodes[current.weather_code] || "Non specificata",
          vento: `${current.wind_speed_10m} km/h`
        },
        previsioni_prossimi_giorni: daily.time.map((date, idx) => ({
          data: date,
          condizione: weatherCodes[daily.weather_code[idx]] || "Non specificata",
          temp_max: `${daily.temperature_2m_max[idx]}°C`,
          temp_min: `${daily.temperature_2m_min[idx]}°C`,
          probabilita_pioggia: `${daily.precipitation_probability_max[idx]}%`
        }))
      };

      return JSON.stringify(forecastInfo);
    } catch (err) {
      return `Errore durante il recupero del meteo: ${err.message}`;
    }
  }
};
