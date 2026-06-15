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

    const o    = rows[0];
    const data = zijde === 'achter' ? o.bestand_data_achter : o.bestand_data;
    const naam = zijde === 'achter' ? (o.bestand_naam_achter || 'achterzijde') : (o.bestand_naam || 'bestand');
    const type = zijde === 'achter' ? (o.bestand_type_achter || 'application/octet-stream')
                                    : (o.bestand_type || 'application/octet-stream');

    if (!data) {
      return { statusCode: 404, headers: { ...cors, 'Content-Type': 'application/json' },
               body: JSON.stringify({ error: 'Geen bestand opgeslagen voor deze order (' + zijde + 'zijde)' }) };
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
