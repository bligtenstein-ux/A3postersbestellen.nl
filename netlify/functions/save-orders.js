const { neon } = require('@neondatabase/serverless');

async function getDb() {
  const sql = neon(process.env.DATABASE_URL);
  await sql`
    CREATE TABLE IF NOT EXISTS orders (
      ordernummer TEXT PRIMARY KEY,
      klant JSONB,
      bestelling JSONB,
      gripp_offerte_id TEXT,
      bestand_naam TEXT,
      bestand_data TEXT,
      bestand_type TEXT,
      status TEXT DEFAULT 'nieuw',
      aangemaakt TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  return sql;
}

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const body = JSON.parse(event.body || '{}');
    const { ordernummer, klant, bestelling, gripp_offerte_id,
            bestand_data, bestand_naam, bestand_type } = body;

    if (!ordernummer) return { statusCode: 400, headers, body: JSON.stringify({ error: 'ordernummer verplicht' }) };

    const sql = await getDb();

    await sql`
      INSERT INTO orders (ordernummer, klant, bestelling, gripp_offerte_id,
                          bestand_naam, bestand_data, bestand_type, status)
      VALUES (
        ${ordernummer},
        ${JSON.stringify(klant)},
        ${JSON.stringify(bestelling)},
        ${gripp_offerte_id || null},
        ${bestand_naam || null},
        ${bestand_data || null},
        ${bestand_type || null},
        'nieuw'
      )
      ON CONFLICT (ordernummer) DO NOTHING
    `;

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, ordernummer }) };

  } catch (err) {
    console.error('save-order fout:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: err.message }) };
  }
};
