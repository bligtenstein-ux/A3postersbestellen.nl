// netlify/functions/get-bestand.js
// Levert het drukbestand van een order als download.
// Auth: accepteert zowel een normale sessie (X-Session-Token) als het
// noodwachtwoord (X-Admin-Secret) — gelijk aan get-orders.js.
// ?zijde=achter haalt het achterzijde-bestand op (dubbelzijdige orders)
// ?ontwerp=N haalt het bestand uit een specifiek ontwerp (multi-ontwerp orders)

const { neon } = require('@neondatabase/serverless');

// Controleer toegang: geldig sessie-token OF het juiste ADMIN_SECRET.
// Geeft true terug bij geldige toegang, anders false.
async function heeftToegang(event, sql) {
  // 1) Noodtoegang via ADMIN_SECRET (headernaam case-insensitief ophalen)
  const secret = event.headers['x-admin-secret'] || event.headers['X-Admin-Secret'];
  if (secret && secret === process.env.ADMIN_SECRET) return true;

  // 2) Normale sessie via X-Session-Token — geldig als het token bestaat
  //    en nog niet is verlopen (admin_sessions.verloopt > NOW()).
  const token = event.headers['x-session-token'] || event.headers['X-Session-Token'];
  if (token) {
    try {
      const rows = await sql`
        SELECT token FROM admin_sessions
        WHERE token = ${token} AND verloopt > NOW()
        LIMIT 1`;
      if (rows.length) return true;
    } catch (e) {
      console.error('sessie-validatie fout:', e);
    }
  }
  return false;
}

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Secret, X-Session-Token',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };

  const sql = neon(process.env.DATABASE_URL);

  // Beveiliging — geldige sessie of noodwachtwoord vereist
  if (!(await heeftToegang(event, sql))) {
    return { statusCode: 401, headers: { ...cors, 'Content-Type': 'application/json' },
             body: JSON.stringify({ error: 'Niet geautoriseerd' }) };
  }

  const ordernummer = event.queryStringParameters?.ordernummer;
  const zijde       = event.queryStringParameters?.zijde || 'voor';
  const ontwerpIdx  = event.queryStringParameters?.ontwerp; // optioneel: index in ontwerpen[]
  if (!ordernummer) {
    return { statusCode: 400, headers: { ...cors, 'Content-Type': 'application/json' },
             body: JSON.stringify({ error: 'ordernummer verplicht' }) };
  }

  try {
    const rows = await sql`SELECT * FROM orders WHERE ordernummer = ${ordernummer}`;

    if (!rows.length) {
      return { statusCode: 404, headers: { ...cors, 'Content-Type': 'application/json' },
               body: JSON.stringify({ error: 'Order niet gevonden' }) };
    }

    const o = rows[0];

    let data, naam, type;

    // Als een ontwerp-index is meegegeven én de order heeft een ontwerpen-lijst,
    // dan halen we het bestand uit dat specifieke ontwerp (multi-ontwerp orders).
    // Anders vallen we terug op de losse kolommen (eerste/enige ontwerp).
    const lijst = Array.isArray(o.ontwerpen) ? o.ontwerpen : null;
    if (ontwerpIdx != null && lijst && lijst[parseInt(ontwerpIdx)]) {
      const ont = lijst[parseInt(ontwerpIdx)];
      if (zijde === 'achter') {
        data = ont.bestand_data_achter;
        naam = ont.bestandsnaam_achter || ont.bestand_naam_achter || 'achterzijde';
        type = ont.bestand_type_achter || 'application/octet-stream';
      } else {
        data = ont.bestand_data;
        naam = ont.bestandsnaam || ont.bestand_naam || 'bestand';
        type = ont.bestand_type || 'application/octet-stream';
      }
    } else {
      data = zijde === 'achter' ? o.bestand_data_achter : o.bestand_data;
      naam = zijde === 'achter' ? (o.bestand_naam_achter || 'achterzijde') : (o.bestand_naam || 'bestand');
      type = zijde === 'achter' ? (o.bestand_type_achter || 'application/octet-stream')
                                : (o.bestand_type || 'application/octet-stream');
    }

    if (!data) {
      return { statusCode: 404, headers: { ...cors, 'Content-Type': 'application/json' },
               body: JSON.stringify({ error: 'Geen bestand opgeslagen voor deze order (' + zijde + 'zijde' + (ontwerpIdx != null ? ', ontwerp ' + ontwerpIdx : '') + ')' }) };
    }

    return {
      statusCode: 200,
      headers: {
        ...cors,
        'Content-Type': type,
        'Content-Disposition': `attachment; filename="${naam.replace(/"/g, '')}"`,
      },
      body: data,            // base64 zoals opgeslagen door save-order
      isBase64Encoded: true,
    };

  } catch (err) {
    console.error('get-bestand fout:', err);
    return { statusCode: 500, headers: { ...cors, 'Content-Type': 'application/json' },
             body: JSON.stringify({ error: err.message }) };
  }
};
