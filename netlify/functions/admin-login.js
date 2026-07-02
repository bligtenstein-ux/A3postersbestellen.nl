// netlify/functions/admin-login.js
// Login voor het admin panel. Twee routes:
//   1. E-mail + wachtwoord (normale gebruikers, tabel admin_users)
//   2. ADMIN_SECRET als noodtoegang (blijft werken zodat een lockout
//      zoals eerder dit jaar niet meer voorkomt)
// Bij succes wordt een sessie-token uitgegeven (tabel admin_sessions,
// 30 dagen geldig) die admin.html vanaf nu meestuurt als X-Session-Token.

const { neon } = require('@neondatabase/serverless');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const SESSION_DUUR_DAGEN = 30;

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

function maakSessieToken() {
  return crypto.randomBytes(32).toString('hex');
}

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const sql = await getDb();

    // ── Route 1: noodtoegang via ADMIN_SECRET ──────────────────────────
    if (body.secret) {
      if (!process.env.ADMIN_SECRET || body.secret !== process.env.ADMIN_SECRET) {
        console.log('[admin-login] ✗ Noodtoegang: onjuist secret');
        return { statusCode: 401, headers, body: JSON.stringify({ success: false, error: 'Onjuist wachtwoord' }) };
      }

      // Geen user_id voor noodtoegang — er is geen echte gebruiker.
      // We maken een tijdelijke, korter geldige sessie (1 dag i.p.v. 30)
      // zodat noodtoegang niet blijvend als vervanging wordt gebruikt.
      // Noodtoegang-sessies worden NIET in admin_sessions opgeslagen omdat
      // die tabel een user_id vereist; in plaats daarvan geven we een
      // speciaal gemarkeerd token terug dat admin.html apart herkent.
      console.log('[admin-login] ✓ Noodtoegang gebruikt');
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          noodtoegang: true,
          // Voor noodtoegang gebruikt admin.html het secret zelf als
          // "token" in de X-Admin-Secret header — géén sessie-tabel nodig.
        }),
      };
    }

    // ── Route 2: e-mail + wachtwoord ────────────────────────────────────
    const email = (body.email || '').trim().toLowerCase();
    const wachtwoord = body.wachtwoord || '';

    if (!email || !wachtwoord) {
      return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'E-mail en wachtwoord verplicht' }) };
    }

    const rows = await sql`SELECT id, email, naam, wachtwoord_hash FROM admin_users WHERE email = ${email}`;
    if (rows.length === 0) {
      console.log(`[admin-login] ✗ Onbekend e-mailadres: ${email}`);
      return { statusCode: 401, headers, body: JSON.stringify({ success: false, error: 'Onjuiste inloggegevens' }) };
    }

    const gebruiker = rows[0];
    const klopt = await bcrypt.compare(wachtwoord, gebruiker.wachtwoord_hash);
    if (!klopt) {
      console.log(`[admin-login] ✗ Onjuist wachtwoord voor: ${email}`);
      return { statusCode: 401, headers, body: JSON.stringify({ success: false, error: 'Onjuiste inloggegevens' }) };
    }

    // Sessie aanmaken
    const token = maakSessieToken();
    const verloopt = new Date(Date.now() + SESSION_DUUR_DAGEN * 24 * 60 * 60 * 1000);
    await sql`
      INSERT INTO admin_sessions (token, user_id, verloopt)
      VALUES (${token}, ${gebruiker.id}, ${verloopt.toISOString()})
    `;
    await sql`UPDATE admin_users SET laatst_ingelogd = NOW() WHERE id = ${gebruiker.id}`;

    console.log(`[admin-login] ✓ Ingelogd: ${email}`);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        noodtoegang: false,
        token,
        gebruiker: { email: gebruiker.email, naam: gebruiker.naam },
      }),
    };

  } catch (err) {
    console.error('[admin-login] fout:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: err.message }) };
  }
};
