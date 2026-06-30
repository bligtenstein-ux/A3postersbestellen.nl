// netlify/functions/gripp-order.js
// Gripp koppeling voor a3postersbestellen.nl
//
// Environment variables (Netlify → Site settings → Environment):
//   GRIPP_API_TOKEN — jouw Gripp API token
//   ADMIN_SECRET    — zelf te kiezen geheim, admin stuurt dit mee als header

const GRIPP_API   = 'https://api.gripp.com/public/api3.php';
const TEMPLATE_ID = 40; // Buro Extern sjabloon

// Product wordt opgezocht op NUMMER (1041 = "Drukwerk"), niet op naam.
// Dit product wordt gebruikt voor alle offerteregels (poster + eventuele korting).
const PRODUCT_NUMMER = '1041';

// Prijsstaffel (zelfde als frontend — backup berekening)
const STAFFEL = [
  { min: 1,   max: 9,   prijs: 4.95 },
  { min: 10,  max: 24,  prijs: 3.95 },
  { min: 25,  max: 49,  prijs: 3.25 },
  { min: 50,  max: 99,  prijs: 2.75 },
  { min: 100, max: 249, prijs: 2.25 },
  { min: 250, max: Infinity, prijs: 1.95 },
];

function getPrijsPerStuk(aantal) {
  const tier = STAFFEL.find(t => aantal >= t.min && aantal <= t.max);
  return tier ? tier.prijs : 1.95;
}

// ── Gripp API aanroepen ─────────────────────────────────────────────────────
async function gripp(token, calls) {
  const resp = await fetch(GRIPP_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(calls),
  });
  if (!resp.ok) throw new Error(`Gripp HTTP ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  return Array.isArray(data) ? data : [data];
}

// ── Product-ID ophalen op productnummer ─────────────────────────────────────
// Eerst directe filter op product.number (snel). Als die geen resultaat of een
// fout geeft, pagineren we door alle producten en matchen op row.number.
async function haalProductId(token) {
  // Strategie 1: directe filter op product.number
  try {
    const res = await gripp(token, [{
      method: 'product.get',
      params: [
        [{ field: 'product.number', operator: 'equals', value: PRODUCT_NUMMER }],
        { paging: { firstresult: 0, maxresults: 5 } },
      ],
      id: 1,
    }]);
    const rows = res[0]?.result?.rows ?? [];
    if (rows.length > 0) {
      console.log(`✓ Drukwerk gevonden via filter: id=${rows[0].id}, nummer=${rows[0].number}, naam="${rows[0].name}"`);
      return rows[0].id;
    }
    console.log(`Filter op product.number=${PRODUCT_NUMMER} gaf 0 resultaten — val terug op paginering`);
  } catch (err) {
    console.log(`Filter op product.number gaf fout (val terug op paginering): ${err.message}`);
  }

  // Strategie 2: paginering door alle producten
  const PAGE_SIZE = 250;
  for (let pagina = 0; pagina < 20; pagina++) {
    const offset = pagina * PAGE_SIZE;
    const res = await gripp(token, [{
      method: 'product.get',
      params: [
        [{ field: 'product.id', operator: 'greaterequals', value: 1 }],
        {
          paging: { firstresult: offset, maxresults: PAGE_SIZE },
          orderings: [{ field: 'product.id', direction: 'asc' }],
        },
      ],
      id: 1,
    }]);

    const rows = res[0]?.result?.rows ?? [];

    for (const row of rows) {
      const nummer = String(row.number ?? row.productnumber ?? '').trim();
      if (nummer === PRODUCT_NUMMER) {
        console.log(`✓ Drukwerk gevonden via paginering: id=${row.id}, nummer=${nummer}, naam="${row.name}"`);
        return row.id;
      }
    }

    if (rows.length < PAGE_SIZE) break; // Laatste pagina
  }

  console.log(`✗ Drukwerk product met nummer ${PRODUCT_NUMMER} NIET gevonden`);
  return null;
}

// ── Klant zoeken of aanmaken ────────────────────────────────────────────────
async function zoekOfMaakRelatie(token, klant) {
  // 1. Zoek op KVK
  if (klant.kvk) {
    const res = await gripp(token, [{
      method: 'company.search',
      params: [[{ field: 'company.cocnumber', operator: 'equals', value: klant.kvk }], {}, 1, 0],
      id: 1,
    }]);
    const rows = res[0]?.result?.rows;
    if (rows?.length > 0) {
      console.log(`Bestaande relatie gevonden op KVK: id=${rows[0].id}`);
      return rows[0].id;
    }
  }

  // 2. Zoek op e-mail
  const res2 = await gripp(token, [{
    method: 'company.search',
    params: [[{ field: 'company.email', operator: 'equals', value: klant.email }], {}, 1, 0],
    id: 1,
  }]);
  const rows2 = res2[0]?.result?.rows;
  if (rows2?.length > 0) {
    console.log(`Bestaande relatie gevonden op e-mail: id=${rows2[0].id}`);
    return rows2[0].id;
  }

  // 3. Aanmaken
  const nieuw = await gripp(token, [{
    method: 'company.create',
    params: [{
      companyname: klant.bedrijf || klant.naam || klant.email,
      email:       klant.email,
      cocnumber:   klant.kvk || '',
      phone:       klant.telefoon || '',
      address:     klant.adres || '',
      zipcode:     klant.postcode || '',
      city:        klant.stad || '',
      country:     klant.land || 'Nederland',
      relationtype: { id: 1 },
    }],
    id: 1,
  }]);

  const id = nieuw[0]?.result?.id || nieuw[0]?.result?.recordid;
  if (!id) throw new Error('Relatie aanmaken mislukt: ' + JSON.stringify(nieuw[0]?.result));
  console.log(`Nieuwe relatie aangemaakt: id=${id}`);
  return id;
}

// ── Offerteregel bouwen ─────────────────────────────────────────────────────
// KRITIEK: product is een GETAL, niet { id: getal } — Gripp API v3 vereiste
function maakRegel(productId, aantal, prijs, omschrijving) {
  return {
    product:      productId,
    amount:       aantal,
    sellingprice: prijs,
    buyingprice:  0,
    discount:     0,
    invoicebasis: 'FIXED',
    rowtype:      'NORMAL',
    description:  omschrijving,
  };
}

// ── Testmodus ───────────────────────────────────────────────────────────────
async function testVerbinding(token) {
  const productId = await haalProductId(token);
  return {
    DRUKWERK_1041: {
      nummer:   PRODUCT_NUMMER,
      gevonden: !!productId,
      gripp_id: productId || null,
    },
  };
}

// ── Hoofd handler ───────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Secret',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');

    const token = body.gripp_token || process.env.GRIPP_API_TOKEN || '';
    if (!token) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ success: false, error: 'GRIPP_API_TOKEN niet ingesteld' }),
      };
    }

    // ── Testmodus ──────────────────────────────────────────────────────
    if (body.test === true) {
      const resultaat = await testVerbinding(token);
      const alleGevonden = Object.values(resultaat).every(r => r.gevonden);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, test: true, alleGevonden, producten: resultaat }),
      };
    }

    // ── Valideer verplichte velden ─────────────────────────────────────
    const { klant, bestelling } = body;
    if (!klant?.email) {
      return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'klant.email verplicht' }) };
    }
    if (!bestelling?.aantal || bestelling.aantal < 1) {
      return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'bestelling.aantal verplicht' }) };
    }

    // ── Haal Drukwerk product-ID op ────────────────────────────────────
    const productId = await haalProductId(token);
    if (!productId) {
      throw new Error(`Drukwerk product met nummer ${PRODUCT_NUMMER} niet gevonden in Gripp.`);
    }

    // ── Klant zoeken of aanmaken ───────────────────────────────────────
    const companyId = await zoekOfMaakRelatie(token, klant);

    // ── Prijs berekenen ────────────────────────────────────────────────
    const aantal       = parseInt(bestelling.aantal);
    const prijsPerStuk = bestelling.prijs_per_stuk ?? getPrijsPerStuk(aantal);
    const methode      = bestelling.verzendmethode ?? 'verzenden'; // 'verzenden' | 'afhalen'
    const ordernummer  = bestelling.ordernummer || `PS-${Date.now()}`;

    // ── Offerteregels bouwen ───────────────────────────────────────────
    const offerlines = [];

    // Regel 1: A3 posters op product 1041 (Drukwerk)
    const bestandsinfo = bestelling.bestandsnaam ? ` (bestand: ${bestelling.bestandsnaam})` : '';
    offerlines.push(maakRegel(
      productId,
      aantal,
      prijsPerStuk,
      `A3 poster full color${bestandsinfo}`,
    ));

    // Verzendkosten zijn altijd gratis — geen aparte verzendregel.
    // Methode (verzenden/afhalen) wordt vermeld in de omschrijving hieronder.

    // Regel 2: korting (negatief bedrag) — optioneel
    if (bestelling.korting?.bedrag > 0) {
      offerlines.push(maakRegel(
        productId,
        1,
        -Math.abs(bestelling.korting.bedrag),
        `Korting${bestelling.korting.code ? ' — ' + bestelling.korting.code : ''}`,
      ));
    }

    // ── Offerte aanmaken in Gripp ──────────────────────────────────────
    const today   = new Date().toISOString().split('T')[0];
    const subject = `A3 poster order ${ordernummer}`;
    const descRegels = [
      `Bestelling: ${aantal}× A3 poster`,
      `Prijs p/st: €${prijsPerStuk.toFixed(2)}`,
      methode === 'afhalen'
        ? 'Verzending: Afhalen te Alkmaar (gratis)'
        : `Verzending: gratis (${bestelling.verzendland || 'NL'})`,
      bestelling.opmerkingen ? `Opmerking: ${bestelling.opmerkingen}` : '',
      bestelling.bestand_url ? `Bestand: ${bestelling.bestand_url}` : '',
    ].filter(Boolean).join('\n');

    console.log(`Offerte aanmaken: ${offerlines.length} regels, company=${companyId}, order=${ordernummer}, template=${TEMPLATE_ID}`);

    const offerteResp = await gripp(token, [{
      method: 'offer.create',
      params: [{
        company:     companyId,
        template:    TEMPLATE_ID,
        name:        `A3 Poster ${ordernummer}`,
        subject,
        description: descRegels,
        date:        today,
        status:      'CONCEPT',
        offerlines,
      }],
      id: 1,
    }]);

    const result    = offerteResp[0]?.result;
    const offerteId = result?.id || result?.recordid;
    if (!offerteId) throw new Error('Offerte aanmaken mislukt: ' + JSON.stringify(result));

    console.log(`✓ Offerte ${offerteId} aangemaakt voor ${ordernummer}`);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success:          true,
        gripp_offerte_id: offerteId,
        company_id:       companyId,
        ordernummer,
      }),
    };

  } catch (err) {
    console.error('Gripp fout:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ success: false, error: err.message }),
    };
  }
};
