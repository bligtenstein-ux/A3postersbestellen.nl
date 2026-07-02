// netlify/functions/admin-users.js
// Beheer van admin-gebruikersaccounts: aanmaken, bewerken, verwijderen, lijst.
// Toegang vereist: geldige sessie-token (ingelogde gebruiker) of ADMIN_SECRET
// (noodtoegang). Zie ook get-orders.js voor dezelfde verifyAuth-logica.

const { neon } = require('@neondatabase/serverless');
const bcrypt = require('bcryptjs');

const MIN_WACHTWOORD_LENGTE = 8;

async function getDb() {
  const sql = neon(process.env.DATABASE_URL);
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
// Zelfde logica als get-orders.js — bewust gedupliceerd i.p.v. gedeeld
// bestand, consistent met hoe de rest van dit project functions opbouwt.
async function verifyAuth(sql, event) {
  const secretHeader = event.headers['x-admin-secret'] || event.queryStringParameters?.secret;
  if (secretHeader && process.env.ADMIN_SECRET && secretHeader === process.env.ADMIN_SECRET) {
    return { ok: true, isNoodtoegang: true, userId: null, email: null };
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

    // ── Lijst ────────────────────────────────────────────────────────
    if (action === 'list' && event.httpMethod === 'GET') {
      const users = await sql`
        SELECT id, email, naam, aangemaakt, laatst_ingelogd
        FROM admin_users
        ORDER BY aangemaakt ASC
      `;
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, users }) };
    }

    // ── Aanmaken ─────────────────────────────────────────────────────
    if (action === 'create' && event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const email = (body.email || '').trim().toLowerCase();
      const naam = (body.naam || '').trim();
      const wachtwoord = body.wachtwoord || '';

      if (!email || !email.includes('@')) {
        return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'Geldig e-mailadres verplicht' }) };
      }
      if (wachtwoord.length < MIN_WACHTWOORD_LENGTE) {
        return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: `Wachtwoord moet minstens ${MIN_WACHTWOORD_LENGTE} tekens zijn` }) };
      }

      const bestaat = await sql`SELECT id FROM admin_users WHERE email = ${email}`;
      if (bestaat.length > 0) {
        return { statusCode: 409, headers, body: JSON.stringify({ success: false, error: 'E-mailadres is al in gebruik' }) };
      }

      const hash = await bcrypt.hash(wachtwoord, 10);
      const rows = await sql`
        INSERT INTO admin_users (email, naam, wachtwoord_hash)
        VALUES (${email}, ${naam || null}, ${hash})
        RETURNING id, email, naam, aangemaakt
      `;

      console.log(`[admin-users] ✓ Gebruiker aangemaakt: ${email} (door ${auth.isNoodtoegang ? 'noodtoegang' : auth.email})`);
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, user: rows[0] }) };
    }

    // ── Bewerken ─────────────────────────────────────────────────────
    if (action === 'update' && event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const id = parseInt(body.id);
      if (!id) {
        return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'id verplicht' }) };
      }

      const bestaande = await sql`SELECT id FROM admin_users WHERE id = ${id}`;
      if (bestaande.length === 0) {
        return { statusCode: 404, headers, body: JSON.stringify({ success: false, error: 'Gebruiker niet gevonden' }) };
      }

      const naam = body.naam !== undefined ? body.naam.trim() : undefined;
      const email = body.email !== undefined ? body.email.trim().toLowerCase() : undefined;
      const wachtwoord = body.wachtwoord || '';

      if (email !== undefined) {
        if (!email || !email.includes('@')) {
          return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'Geldig e-mailadres verplicht' }) };
        }
        const emailInGebruik = await sql`SELECT id FROM admin_users WHERE email = ${email} AND id != ${id}`;
        if (emailInGebruik.length > 0) {
          return { statusCode: 409, headers, body: JSON.stringify({ success: false, error: 'E-mailadres is al in gebruik door een andere gebruiker' }) };
        }
      }

      if (wachtwoord && wachtwoord.length < MIN_WACHTWOORD_LENGTE) {
        return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: `Wachtwoord moet minstens ${MIN_WACHTWOORD_LENGTE} tekens zijn` }) };
      }

      const nieuwHash = wachtwoord ? await bcrypt.hash(wachtwoord, 10) : null;

      const rows = await sql`
        UPDATE admin_users SET
          naam = COALESCE(${naam !== undefined ? naam : null}, naam),
          email = COALESCE(${email !== undefined ? email : null}, email),
          wachtwoord_hash = COALESCE(${nieuwHash}, wachtwoord_hash)
        WHERE id = ${id}
        RETURNING id, email, naam, aangemaakt, laatst_ingelogd
      `;

      // Bij wachtwoordwijziging: alle bestaande sessies van deze gebruiker
      // intrekken, zodat een oud (mogelijk gelekt) wachtwoord niet nog
      // ergens ingelogd blijft.
      if (nieuwHash) {
        await sql`DELETE FROM admin_sessions WHERE user_id = ${id}`;
        console.log(`[admin-users] Wachtwoord gewijzigd voor gebruiker ${id} — alle sessies ingetrokken`);
      }

      console.log(`[admin-users] ✓ Gebruiker ${id} bijgewerkt (door ${auth.isNoodtoegang ? 'noodtoegang' : auth.email})`);
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, user: rows[0] }) };
    }

    // ── Verwijderen ──────────────────────────────────────────────────
    if (action === 'delete' && event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const id = parseInt(body.id);
      if (!id) {
        return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'id verplicht' }) };
      }

      // Jezelf verwijderen kan niet — voorkomt dat je jezelf per ongeluk buitensluit.
      if (!auth.isNoodtoegang && auth.userId === id) {
        return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'Je kunt je eigen account niet verwijderen' }) };
      }

      // De laatste overgebleven gebruiker kan niet verwijderd worden —
      // anders is er straks alleen nog noodtoegang over.
      const aantal = await sql`SELECT COUNT(*)::int AS n FROM admin_users`;
      if (aantal[0].n <= 1) {
        return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'De laatste gebruiker kan niet verwijderd worden' }) };
      }

      const result = await sql`DELETE FROM admin_users WHERE id = ${id} RETURNING email`;
      if (result.length === 0) {
        return { statusCode: 404, headers, body: JSON.stringify({ success: false, error: 'Gebruiker niet gevonden' }) };
      }

      console.log(`[admin-users] ✓ Gebruiker ${result[0].email} verwijderd (door ${auth.isNoodtoegang ? 'noodtoegang' : auth.email})`);
      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'Onbekende actie' }) };

  } catch (err) {
    console.error('[admin-users] fout:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: err.message }) };
  }
};
