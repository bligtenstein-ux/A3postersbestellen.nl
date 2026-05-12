const { neon } = require('@neondatabase/serverless');

async function getDb() {
  const sql = neon(process.env.DATABASE_URL);
  await sql`
    CREATE TABLE IF NOT EXISTS orders (
      ordernummer TEXT PRIMARY KEY,
      klant JSONB,
      bestelling JSONB,
      gripp_offerte_id TEXT,
      bestand_url TEXT,
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
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Secret',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const secret = event.headers['x-admin-secret'] || event.queryStringParameters?.secret;
  if (secret !== process.env.ADMIN_SECRET) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Niet geautoriseerd' }) };
  }

  try {
    const sql = await getDb();
    const action = event.queryStringParameters?.action || 'list';

    if (action === 'update_status' && event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      await sql`
        UPDATE orders SET
          status = ${body.status},
          gripp_offerte_id = COALESCE(${body.gripp_offerte_id || null}, gripp_offerte_id)
        WHERE ordernummer = ${body.ordernummer}
      `;
      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }

    const orders = await sql`
      SELECT ordernummer, klant, bestelling, gripp_offerte_id,
             bestand_url, bestand_naam, bestand_type, status, aangemaakt
      FROM orders
      ORDER BY aangemaakt DESC
      LIMIT 200
    `;

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, orders }) };

  } catch (err) {
    console.error('get-orders fout:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: err.message }) };
  }
};
