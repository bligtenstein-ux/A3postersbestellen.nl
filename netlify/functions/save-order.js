// netlify/functions/save-order.js
// Slaat orders + drukbestand(en) op in de Neon database en stuurt een
// order-notificatie per e-mail naar print@extern.nl via Resend, plus een
// orderbevestiging naar de klant (klant-bevestiging.js).
// Ondersteunt dubbelzijdig drukken (achterzijde-bestand) en het geval dat een
// bestand te groot was om mee te sturen (bestand_te_groot → klant stuurt per mail).
//
// 9 nov 2026 — status + reden:
//   - Komt een order binnen zonder (alle) drukbestanden, dan krijgt hij status
//     'wacht_op_bestanden' i.p.v. 'nieuw', en de klant krijgt in de bevestiging
//     het verzoek de bestanden per mail te sturen.
//   - Nieuwe kolom systeem_melding: leesbare reden waarom bestanden ontbreken
//     en/of waarom Gripp niet lukte. Zichtbaar in de admin.
//   - De frontend stuurt het eerste bestand niet meer dubbel (topniveau én in
//     ontwerpen[0]) — dat verdubbelde de payload en liet orders vanaf ~2,2 MB
//     stil mislukken (PS-97381). De losse bestand_*-kolommen vullen we daarom
//     hier zelf uit ontwerpen[0] als ze leeg binnenkomen.

const { neon } = require('@neondatabase/serverless');
const { Resend } = require('resend');
const { stuurKlantBevestiging, bouwInterneHtml, interneOnderwerp } = require('./klant-bevestiging');

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
  // Kolom voor meerdere ontwerpen in één order (JSONB-lijst met per ontwerp:
  // aantal, drukzijde, prijs_per_stuk, bestandsnaam/naam_achter, bestand_data/type,
  // bestand_data_achter/type_achter, bestand_te_groot). Backwards-compatible: bij
  // één ontwerp blijven de losse bestand_*-kolommen gevuld met dat ene bestand.
  await sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS ontwerpen JSONB`;
  // Leesbare reden bij afwijkingen (ontbrekende bestanden, Gripp-fout, mislukte
  // eerste opslagpoging). Wordt in de admin getoond.
  await sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS systeem_melding TEXT`;
  return sql;
}

// ── Order-notificatie samenstellen en versturen ─────────────────────────────
// Faalt de mail, dan mag dat de order NIET blokkeren: de order staat al veilig
// in de database. We loggen de fout en gaan door.
async function stuurOrderMail({ ordernummer, klant, bestelling, gripp_offerte_id, bestandTeGroot, systeemMelding }) {
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

  // Meerdere ontwerpen? Dan een specificatie per ontwerp + totaalprijs.
  const ontw = Array.isArray(b.ontwerpen) && b.ontwerpen.length > 1 ? b.ontwerpen : null;

  let bestelBlok;
  if (ontw) {
    const totaalPrijs = ontw.reduce((s, o) => s + (Number(o.prijs_per_stuk) || 0) * (o.aantal || 0), 0);
    bestelBlok = [
      `— Bestelling — ${b.aantal ?? '—'} posters totaal, ${ontw.length} ontwerpen`,
      ...ontw.map((o, i) =>
        `  Ontwerp ${i + 1}: ${o.aantal}× (${o.drukzijde || 'enkel'}) — ${euro(o.prijs_per_stuk)} p/st`
        + (o.bestandsnaam ? ` — ${o.bestandsnaam}` : '')
        + (o.bestandsnaam_achter ? ` + achter: ${o.bestandsnaam_achter}` : '')
      ),
      `Totaal: ${euro(totaalPrijs)}`,
      b.opmerkingen ? `Opmerking: ${b.opmerkingen}` : null,
    ];
  } else {
    const regelPrijs = (b.prijs_per_stuk != null && b.aantal != null)
      ? euro(b.prijs_per_stuk * b.aantal) : '—';
    bestelBlok = [
      `— Bestelling —`,
      `Aantal: ${b.aantal ?? '—'}× A3 poster`,
      `Prijs p/st: ${b.prijs_per_stuk != null ? euro(b.prijs_per_stuk) : '—'}`,
      `Totaal: ${regelPrijs}`,
      `Drukzijde: ${b.drukzijde || 'enkel'}`,
      b.opmerkingen ? `Opmerking: ${b.opmerkingen}` : null,
    ];
  }

  // Platte-tekst body — bewust simpel en volledig, ideaal voor de printworkflow.
  const regels = [
    `Nieuwe order: #${ordernummer}`,
    ``,
    ...bestelBlok,
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
      ? `WACHT OP BESTANDEN — niet meegekomen, klant is gevraagd ze per mail naar ${MAIL_TO} te sturen o.v.v. #${ordernummer}.`
      : `Bestand: ${b.bestandsnaam || '(zie admin)'}${b.bestandsnaam_achter ? ' + achterzijde: ' + b.bestandsnaam_achter : ''}`,
    systeemMelding ? `\n— Systeemmelding —\n${systeemMelding}` : null,
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
      subject: interneOnderwerp(ordernummer, gripp_offerte_id, bestandTeGroot),
      html: bouwInterneHtml({ ordernummer, klant: k, bestelling: b, gripp_offerte_id, bestandTeGroot, systeemMelding }),
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
            bestand_te_groot, ontwerpen, opslag_melding, gripp_fout } = body;

    if (!ordernummer) return { statusCode: 400, headers, body: JSON.stringify({ error: 'ordernummer verplicht' }) };

    // Losse bestand_*-kolommen (admin/downloads) vullen uit ontwerpen[0] als de
    // frontend ze niet meer op topniveau meestuurt.
    const o0 = Array.isArray(ontwerpen) && ontwerpen.length > 0 ? ontwerpen[0] : {};
    const bData       = bestand_data        || o0.bestand_data        || null;
    const bNaam       = bestand_naam        || o0.bestand_naam        || o0.bestandsnaam || null;
    const bType       = bestand_type        || o0.bestand_type        || null;
    const bDataAchter = bestand_data_achter || o0.bestand_data_achter || null;
    const bNaamAchter = bestand_naam_achter || o0.bestand_naam_achter || o0.bestandsnaam_achter || null;
    const bTypeAchter = bestand_type_achter || o0.bestand_type_achter || null;

    // Welke bestanden ontbreken? Primair de lijst van de frontend; als die er
    // niet is (oude/gecachte frontend) afleiden uit ontwerpen[] zelf.
    let ontbrekend = Array.isArray(bestelling?.bestanden_ontbreken) ? bestelling.bestanden_ontbreken : null;
    if (!ontbrekend) {
      ontbrekend = [];
      (Array.isArray(ontwerpen) && ontwerpen.length ? ontwerpen : [{
        bestand_naam: bNaam, bestand_data: bData, bestand_naam_achter: bNaamAchter, bestand_data_achter: bDataAchter,
      }]).forEach((o, i) => {
        if ((o.bestand_naam || o.bestandsnaam) && !o.bestand_data)
          ontbrekend.push({ ontwerp: i + 1, zijde: 'voor', naam: o.bestand_naam || o.bestandsnaam, reden: 'niet meegestuurd' });
        if ((o.bestand_naam_achter || o.bestandsnaam_achter) && !o.bestand_data_achter)
          ontbrekend.push({ ontwerp: i + 1, zijde: 'achter', naam: o.bestand_naam_achter || o.bestandsnaam_achter, reden: 'niet meegestuurd' });
      });
    }
    const wachtOpBestanden = !!bestand_te_groot || ontbrekend.length > 0;
    const status = wachtOpBestanden ? 'wacht_op_bestanden' : 'nieuw';

    // Leesbare reden voor de admin.
    const mb = n => Number(n) > 0 ? ` (${(n / 1024 / 1024).toFixed(1).replace('.', ',')} MB)` : '';
    const meldingRegels = [];
    if (ontbrekend.length) {
      meldingRegels.push('Bestanden niet ontvangen — klant gevraagd ze per mail te sturen:');
      ontbrekend.forEach(f => meldingRegels.push(
        `• Ontwerp ${f.ontwerp || 1}${f.zijde === 'achter' ? ' achterzijde' : ''}: ${f.naam || '?'}${mb(f.grootte)} — ${f.reden || 'te groot'}`));
    } else if (bestand_te_groot) {
      meldingRegels.push('Bestand(en) te groot voor directe upload — klant gevraagd ze per mail te sturen.');
    }
    if (opslag_melding) meldingRegels.push(String(opslag_melding));
    if (!gripp_offerte_id && gripp_fout) meldingRegels.push(`Gripp: ${gripp_fout}`);
    const systeemMelding = meldingRegels.join('\n') || null;
    if (systeemMelding) console.warn(`[save-order] ${ordernummer} — ${systeemMelding.replace(/\n/g, ' | ')}`);

    const sql = await getDb();

    // BELANGRIJK: geen ON CONFLICT DO NOTHING (dat slikt een botsend ordernummer
    // stil in met HTTP 200 — orders verdwijnen dan onopgemerkt). We gebruiken
    // RETURNING en detecteren een botsing expliciet, zodat de frontend een echt
    // succes-signaal krijgt en de mail alleen bij een echte insert vuurt.
    const rows = await sql`
      INSERT INTO orders (ordernummer, klant, bestelling, gripp_offerte_id,
                          bestand_naam, bestand_data, bestand_type,
                          bestand_naam_achter, bestand_data_achter, bestand_type_achter,
                          ontwerpen, status, systeem_melding)
      VALUES (
        ${ordernummer},
        ${JSON.stringify(klant)},
        ${JSON.stringify(bestelling)},
        ${gripp_offerte_id || null},
        ${bNaam},
        ${bData},
        ${bType},
        ${bNaamAchter},
        ${bDataAchter},
        ${bTypeAchter},
        ${Array.isArray(ontwerpen) && ontwerpen.length > 0 ? JSON.stringify(ontwerpen) : null},
        ${status},
        ${systeemMelding}
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
    await stuurOrderMail({ ordernummer, klant, bestelling, gripp_offerte_id, bestandTeGroot: wachtOpBestanden, systeemMelding });

    // Orderbevestiging naar de klant (faalt nooit de order; fout wordt gelogd).
    if (process.env.RESEND_API_KEY) {
      await stuurKlantBevestiging({
        resend: new Resend(process.env.RESEND_API_KEY),
        from: MAIL_FROM, ordernummer, klant, bestelling,
        bestandTeGroot: wachtOpBestanden,
      });
    } else {
      console.warn('[save-order] RESEND_API_KEY ontbreekt — geen klantbevestiging verstuurd.');
    }

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, ordernummer, status }) };
  } catch (err) {
    console.error('save-order fout:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: err.message }) };
  }
};
