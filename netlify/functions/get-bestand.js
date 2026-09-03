// netlify/functions/get-bestand.js
// Levert het drukbestand van een order als download — beveiligd met ADMIN_SECRET
// Nieuw: ?zijde=achter haalt het achterzijde-bestand op (dubbelzijdige orders)

const { neon } = require('@neondatabase/serverless');

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Secret',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };

  // Beveiliging — secret uitsluitend via header (niet via URL, dat lekt in logs/history)
  const secret = event.headers['x-admin-secret'];
  if (secret !== process.env.ADMIN_SECRET) {
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
    const sql  = neon(process.env.DATABASE_URL);
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
