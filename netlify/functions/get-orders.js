// netlify/functions/get-orders.js
// Overzicht, status-updates en verwijderen van orders voor het admin panel.
//
// Wijzigingen t.o.v. vorige versie:
//   - action=delete toegevoegd: verwijdert een order (en het opgeslagen
//     bestand) definitief uit de database. De Gripp-offerte blijft bestaan.
//   - BUGFIX: bestand_naam_achter ontbrak in de SELECT van action=list,
//     waardoor het "2-zijdig"-label en de achterzijde-downloadknop in de
//     admin nooit zichtbaar waren, ook als het bestand wél was opgeslagen.
//   - Auth uitgebreid: naast het bestaande ADMIN_SECRET (nu "noodtoegang")
//     wordt ook een geldige sessie-token van een ingelogde gebruiker
//     geaccepteerd (X-Session-Token header). Nodig voor de nieuwe
//     gebruikersaccounts-functionaliteit.

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
  // Kolommen voor dubbelzijdig drukken — bestaan al dankzij save-order.js,
  // maar defensief hier ook aanmaken voor het geval dit de eerste function
  // is die ooit draait tegen een verse database.
  await sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS bestand_naam_achter TEXT`;
  await sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS bestand_data_achter TEXT`;
  await sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS bestand_type_achter TEXT`;

  // Gebruikersaccounts + sessies voor het admin-login-systeem.
  await sql`
    CREATE TABLE IF NOT EXISTS admin_users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      naam TEXT,
      wachtwoord_hash TEXT NOT NULL,
      aangemaakt TIMESTAMPTZ DEFAULT NOW(),
      laatst_ingelogd TIMESTAMPTZ
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS admin_sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
      aangemaakt TIMESTAMPTZ DEFAULT NOW(),
      verloopt TIMESTAMPTZ NOT NULL
    )
  `;

  return sql;
}

// ── Authenticatie: ADMIN_SECRET (noodtoegang) OF geldige sessie-token ──────
async function verifyAuth(sql, event) {
  const secretHeader = event.headers['x-admin-secret'] || event.queryStringParameters?.secret;
  if (secretHeader && process.env.ADMIN_SECRET && secretHeader === process.env.ADMIN_SECRET) {
    return { ok: true, isNoodtoegang: true, userId: null, email: null, naam: null };
  }

  const token = event.headers['x-session-token'];
  if (token) {
    const rows = await sql`
      SELECT s.user_id, s.verloopt, u.email, u.naam
      FROM admin_sessions s
      JOIN admin_users u ON u.id = s.user_id
      WHERE s.token = ${token}
    `;
    if (rows.length > 0 && new Date(rows[0].verloopt) > new Date()) {
      return { ok: true, isNoodtoegang: false, userId: rows[0].user_id, email: rows[0].email, naam: rows[0].naam };
    }
  }

  return { ok: false };
}

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Secret, X-Session-Token',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const sql = await getDb();

    const auth = await verifyAuth(sql, event);
    if (!auth.ok) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Niet geautoriseerd' }) };
    }

    const action = event.queryStringParameters?.action || 'list';

    // ── Status bijwerken ──────────────────────────────────────────────
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

    // ── Order verwijderen ─────────────────────────────────────────────
    if (action === 'delete' && event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      if (!body.ordernummer) {
        return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'ordernummer verplicht' }) };
      }

      const result = await sql`
        DELETE FROM orders WHERE ordernummer = ${body.ordernummer}
        RETURNING ordernummer
      `;

      if (result.length === 0) {
        console.log(`[get-orders] Verwijderen mislukt: ordernummer ${body.ordernummer} niet gevonden`);
        return { statusCode: 404, headers, body: JSON.stringify({ success: false, error: 'Order niet gevonden' }) };
      }

      console.log(`[get-orders] ✓ Order ${body.ordernummer} verwijderd door ${auth.isNoodtoegang ? 'noodtoegang' : auth.email}`);
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, ordernummer: body.ordernummer }) };
    }

    // ── Lijst ophalen (default) ───────────────────────────────────────
    const orders = await sql`
      SELECT ordernummer, klant, bestelling, gripp_offerte_id,
             bestand_naam, bestand_type, bestand_naam_achter, bestand_type_achter,
             status, aangemaakt
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
