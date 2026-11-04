import fetch from 'node-fetch';

const WMO_CODES = {
  0: 'Cielo sereno',
  1: 'Prevalentemente sereno',
  2: 'Parzialmente nuvoloso',
  3: 'Coperto',
  45: 'Nebbia',
  48: 'Nebbia con brina',
  51: 'Pioviggine leggera',
  53: 'Pioviggine moderata',
  55: 'Pioviggine intensa',
  56: 'Pioviggine gelata leggera',
  57: 'Pioviggine gelata intensa',
  61: 'Pioggia debole',
  63: 'Pioggia moderata',
  65: 'Pioggia forte',
  66: 'Pioggia gelata debole',
  67: 'Pioggia gelata forte',
  71: 'Nevicata debole',
  73: 'Nevicata moderata',
  75: 'Nevicata forte',
  77: 'Granelli di neve',
  80: 'Rovesci di pioggia deboli',
  81: 'Rovesci di pioggia moderati',
  82: 'Rovesci di pioggia violenti',
  85: 'Rovesci di neve deboli',
  86: 'Rovesci di neve forti',
  95: 'Temporale',
  96: 'Temporale con grandine debole',
  99: 'Temporale con grandine forte'
};

const describeCode = (code) => WMO_CODES[code] ?? `Condizioni non classificate (codice ${code})`;

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo ha risposto con stato ${res.status}`);
  return res.json();
}

export const tools = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description:
        'Restituisce il meteo attuale (temperatura, temperatura percepita, umidità, vento, condizioni) e le previsioni giornaliere fino a 7 giorni per una località. Se l\'utente non indica la città, usa quella che conosci dalle informazioni salvate oppure chiedila.',
      parameters: {
        type: 'object',
        properties: {
          location: {
            type: 'string',
            description: 'Nome della città o località (es. "Milano", "Lodi").'
          },
          days: {
            type: 'integer',
            description: 'Numero di giorni di previsione da 1 a 7 (default 7).'
          }
        },
        required: ['location']
      }
    }
  }
];

export const handlers = {
  async get_weather({ location, days = 7 }) {
    if (!location || !String(location).trim()) {
      return { error: 'Località mancante.' };
    }
    const forecastDays = Math.min(Math.max(parseInt(days, 10) || 7, 1), 7);

    // 1) Geocoding
    const geo = await getJson(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
        String(location).trim()
      )}&count=1&language=it&format=json`
    );
    const place = geo.results?.[0];
    if (!place) return { error: `Località "${location}" non trovata.` };

    // 2) Previsioni
    const params = new URLSearchParams({
      latitude: place.latitude,
      longitude: place.longitude,
      current: 'temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code',
      daily:
        'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max',
      timezone: 'auto',
      forecast_days: String(forecastDays)
    });
    const data = await getJson(`https://api.open-meteo.com/v1/forecast?${params}`);

    const c = data.current;
    const d = data.daily;

    return {
      localita: [place.name, place.admin1, place.country].filter(Boolean).join(', '),
      fuso_orario: data.timezone,
      attuale: {
        ora: c.time,
        condizioni: describeCode(c.weather_code),
        temperatura_c: c.temperature_2m,
        percepita_c: c.apparent_temperature,
        umidita_percento: c.relative_humidity_2m,
        vento_kmh: c.wind_speed_10m
      },
      previsioni: d.time.map((date, i) => ({
        data: date,
        condizioni: describeCode(d.weather_code[i]),
        temp_min_c: d.temperature_2m_min[i],
        temp_max_c: d.temperature_2m_max[i],
        probabilita_pioggia_percento: d.precipitation_probability_max[i],
        precipitazioni_mm: d.precipitation_sum[i],
        vento_max_kmh: d.wind_speed_10m_max[i]
      }))
    };
  }
};
