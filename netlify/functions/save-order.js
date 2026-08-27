// netlify/functions/save-order.js
// Slaat orders + drukbestand(en) op in de Neon database en stuurt een
// order-notificatie per e-mail naar print@extern.nl via Resend.
// Ondersteunt dubbelzijdig drukken (achterzijde-bestand) en het geval dat een
// bestand te groot was om mee te sturen (bestand_te_groot → klant stuurt via WeTransfer).

const { neon } = require('@neondatabase/serverless');
const { Resend } = require('resend');

// ── Mail-instellingen ───────────────────────────────────────────────────────
// Afzender moet een GEVERIFIEERD Resend-domein zijn. Op dit moment is alleen
// mail.kobaal.com geverifieerd; extern.nl staat nog op "Not Started". Zodra
// extern.nl geverifieerd is, kun je MAIL_FROM wijzigen naar bv. 'orders@extern.nl'.
const MAIL_FROM = 'A3 Posters <a3postersbestellen@mail.kobaal.com>';
const MAIL_TO   = 'print@extern.nl';

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
  // Kolommen voor de achterzijde (dubbelzijdig drukken) — veilig bij bestaande tabel
  await sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS bestand_naam_achter TEXT`;
  await sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS bestand_data_achter TEXT`;
  await sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS bestand_type_achter TEXT`;
  return sql;
}

// ── Order-notificatie samenstellen en versturen ─────────────────────────────
// Faalt de mail, dan mag dat de order NIET blokkeren: de order staat al veilig
// in de database. We loggen de fout en gaan door.
async function stuurOrderMail({ ordernummer, klant, bestelling, gripp_offerte_id, bestandTeGroot }) {
  if (!process.env.RESEND_API_KEY) {
    console.warn('[save-order] RESEND_API_KEY ontbreekt — geen order-mail verstuurd.');
    return;
  }

  const resend = new Resend(process.env.RESEND_API_KEY);

  const k = klant || {};
  const b = bestelling || {};
  const adres = k.adres || {};
  const aflever = k.afleveradres || null;

  const euro = (n) => '€' + Number(n || 0).toFixed(2).replace('.', ',');
  const regelPrijs = (b.prijs_per_stuk != null && b.aantal != null)
    ? euro(b.prijs_per_stuk * b.aantal) : '—';

  // Platte-tekst body — bewust simpel en volledig, ideaal voor de printworkflow.
  const regels = [
    `Nieuwe order: #${ordernummer}`,
    ``,
    `— Bestelling —`,
    `Aantal: ${b.aantal ?? '—'}× A3 poster`,
    `Prijs p/st: ${b.prijs_per_stuk != null ? euro(b.prijs_per_stuk) : '—'}`,
    `Totaal: ${regelPrijs}`,
    `Drukzijde: ${b.drukzijde || 'enkel'}`,
    b.opmerkingen ? `Opmerking: ${b.opmerkingen}` : null,
    ``,
    `— Klant —`,
    k.bedrijf ? `Bedrijf: ${k.bedrijf}` : null,
    k.naam ? `Naam: ${k.naam}` : null,
    k.email ? `E-mail: ${k.email}` : null,
    k.telefoon ? `Telefoon: ${k.telefoon}` : null,
    ``,
    `— Adres —`,
    adres.straat ? adres.straat : null,
    (adres.postcode || adres.plaats) ? `${adres.postcode || ''} ${adres.plaats || ''}`.trim() : null,
    adres.land ? adres.land : null,
  ];

  if (aflever && (aflever.straat || aflever.plaats)) {
    regels.push(
      ``,
      `— Afwijkend afleveradres —`,
      aflever.bedrijf || null,
      aflever.straat || null,
      `${aflever.postcode || ''} ${aflever.plaats || ''}`.trim() || null,
      aflever.land || null,
    );
  }

  regels.push(
    ``,
    `— Bestand —`,
    bestandTeGroot
      ? `⚠️ Bestand was te groot voor directe upload. De klant stuurt het via WeTransfer naar ${MAIL_TO} o.v.v. #${ordernummer}.`
      : `Bestand: ${b.bestandsnaam || '(zie admin)'}${b.bestandsnaam_achter ? ' + achterzijde: ' + b.bestandsnaam_achter : ''}`,
    ``,
    gripp_offerte_id ? `Gripp offerte: ${gripp_offerte_id}` : `Gripp: (nog niet gesynct)`,
    ``,
    `Bekijk in de admin: https://a3postersbestellen.nl/admin`,
  );

  const tekst = regels.filter(r => r !== null && r !== undefined).join('\n');

  try {
    await resend.emails.send({
      from: MAIL_FROM,
      to: MAIL_TO,
      replyTo: k.email || undefined,
      subject: `Nieuwe order op A3postersbestellen.nl #${ordernummer}`,
      text: tekst,
    });
    console.log(`[save-order] ✓ Order-mail verstuurd voor #${ordernummer}`);
  } catch (err) {
    console.error(`[save-order] ⚠️ Order-mail versturen mislukt (order staat wél opgeslagen): ${err.message}`);
  }
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
            bestand_data, bestand_naam, bestand_type,
            bestand_data_achter, bestand_naam_achter, bestand_type_achter,
            bestand_te_groot } = body;

    if (!ordernummer) return { statusCode: 400, headers, body: JSON.stringify({ error: 'ordernummer verplicht' }) };

    const sql = await getDb();

    // BELANGRIJK: geen ON CONFLICT DO NOTHING (dat slikt een botsend ordernummer
    // stil in met HTTP 200 — orders verdwijnen dan onopgemerkt). We gebruiken
    // RETURNING en detecteren een botsing expliciet, zodat de frontend een echt
    // succes-signaal krijgt en de mail alleen bij een echte insert vuurt.
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

    if (rows.length === 0) {
      // Botsend ordernummer: er bestond al een order met dit nummer. Geen nieuwe
      // insert, dus ook geen dubbele mail. Meld het expliciet (409).
      console.warn(`[save-order] ⚠️ Ordernummer ${ordernummer} bestaat al — niet opnieuw opgeslagen.`);
      return { statusCode: 409, headers, body: JSON.stringify({ success: false, error: 'Ordernummer bestaat al', ordernummer }) };
    }

    // Insert geslaagd → order-notificatie versturen (faalt nooit de order).
    await stuurOrderMail({ ordernummer, klant, bestelling, gripp_offerte_id, bestandTeGroot: !!bestand_te_groot });

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, ordernummer }) };
  } catch (err) {
    console.error('save-order fout:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: err.message }) };
  }
};
