// netlify/functions/save-order.js
// Slaat orders + drukbestand(en) op in de Neon database
// Ondersteunt dubbelzijdig drukken: achterzijde-bestand wordt mee opgeslagen.
//
// Wijzigingen t.o.v. vorige versie:
//   - Uitgebreide logging (ordernummer, bestandsgroottes, resultaat)
//   - Collision-detectie via RETURNING: als ordernummer al bestaat, wordt
//     nu 409 teruggegeven i.p.v. valse success zodat de frontend het weet.
//   - Toegestane origins uitgebreid met de www.-variant.
//   - Strikte origin-check via startsWith i.p.v. includes.

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
  await sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS bestand_naam_achter TEXT`;
  await sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS bestand_data_achter TEXT`;
  await sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS bestand_type_achter TEXT`;
  return sql;
}

// ── Hulpfuncties voor logging van bestandsgroottes ──────────────────────────
function base64Size(str) {
  if (!str) return 0;
  const idx = str.indexOf(',');
  const data = idx >= 0 ? str.slice(idx + 1) : str;
  return Math.floor(data.length * 0.75);
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

// ── Hoofd handler ───────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const startTime = Date.now();
  const origin = event.headers?.origin || '';
  const referer = event.headers?.referer || '';

  const TOEGESTANE_HOSTS = [
    'https://a3postersbestellen.nl',
    'https://www.a3postersbestellen.nl',
    'https://a3posters.netlify.app',
  ];
  const allowOrigin = TOEGESTANE_HOSTS.find(h => origin === h) || 'https://a3postersbestellen.nl';

  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  console.log(`[save-order] START — origin=${origin || '(leeg)'}, referer=${referer || '(leeg)'}, method=${event.httpMethod}, body_bytes=${event.body?.length || 0}`);

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    console.log(`[save-order] Method niet toegestaan: ${event.httpMethod}`);
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // Origin/referer-check — alleen verzoeken vanaf de eigen site accepteren.
  const bron = origin || referer;
  const isToegestaan = bron === '' || TOEGESTANE_HOSTS.some(h => bron.startsWith(h));
  if (!isToegestaan) {
    console.log(`[save-order] ✗ Bron niet toegestaan: ${bron}`);
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Niet toegestaan' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (parseErr) {
    console.error(`[save-order] ✗ JSON parse fout: ${parseErr.message}`);
    return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'Ongeldig JSON' }) };
  }

  const { ordernummer, klant, bestelling, gripp_offerte_id,
          bestand_data, bestand_naam, bestand_type,
          bestand_data_achter, bestand_naam_achter, bestand_type_achter } = body;

  console.log(`[save-order] ordernummer=${ordernummer}, klant=${klant?.email || '(geen email)'}, gripp_offerte=${gripp_offerte_id || 'geen'}`);
  console.log(`[save-order] bestand voor: naam=${bestand_naam || 'geen'}, grootte=${formatBytes(base64Size(bestand_data))}`);
  if (bestand_naam_achter) {
    console.log(`[save-order] bestand achter: naam=${bestand_naam_achter}, grootte=${formatBytes(base64Size(bestand_data_achter))}`);
  }

  if (!ordernummer) {
    console.log(`[save-order] ✗ Ordernummer ontbreekt — verzoek geweigerd`);
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'ordernummer verplicht' }) };
  }

  try {
    const sql = await getDb();

    // RETURNING zorgt dat we weten of de rij ook echt is ingevoegd.
    // Bij een collision op ordernummer retourneert Postgres een lege array.
    const rows = await sql`
      INSERT INTO orders (ordernummer, klant, bestelling, gripp_offerte_id,
                          bestand_naam, bestand_data, bestand_type,
                          bestand_naam_achter, bestand_data_achter, bestand_type_achter,
                          status)
      VALUES (
        ${ordernummer},
        ${JSON.stringify(klant)},
        ${JSON.stringify(bestelling)},
        ${gripp_offerte_id || null},
        ${bestand_naam || null},
        ${bestand_data || null},
        ${bestand_type || null},
        ${bestand_naam_achter || null},
        ${bestand_data_achter || null},
        ${bestand_type_achter || null},
        'nieuw'
      )
      ON CONFLICT (ordernummer) DO NOTHING
      RETURNING ordernummer
    `;

    const duur = Date.now() - startTime;

    if (rows.length === 0) {
      // Ordernummer bestond al — dit is een silent-data-loss situatie
      // die we nu wel expliciet maken zodat de frontend het kan afhandelen.
      console.error(`[save-order] ⚠️ COLLISION: ordernummer ${ordernummer} bestaat al in database! Bestand NIET opgeslagen. Duur: ${duur}ms`);
      return {
        statusCode: 409,
        headers,
        body: JSON.stringify({
          success: false,
          error: 'ordernummer_bestaat_al',
          ordernummer,
        }),
      };
    }

    console.log(`[save-order] ✓ SUCCES — order ${ordernummer} opgeslagen. Duur: ${duur}ms`);
    return { statusCode: 200, headers, body: JSON.stringify({ success: true, ordernummer }) };

  } catch (err) {
    const duur = Date.now() - startTime;
    console.error(`[save-order] ✗ DATABASEFOUT voor ${ordernummer}: ${err.message}. Duur: ${duur}ms`);
    console.error(err.stack);
    return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: err.message }) };
  }
};
