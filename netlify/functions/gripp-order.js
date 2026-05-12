// netlify/functions/gripp-order.js
// Gripp koppeling voor a3postersbestellen.nl
// Gebaseerd op kobaal-gripp-v22.ts — aangepast voor Netlify Functions
//
// Environment variables (stel in via Netlify dashboard → Site settings → Environment):
//   GRIPP_API_TOKEN   — jouw Gripp API token
//   ADMIN_SECRET      — zelf te kiezen geheim, admin stuurt dit mee als header

const GRIPP_API   = 'https://api.gripp.com/public/api3.php';
const TEMPLATE_ID = 53; // Zelfde template als Kobaal DTF

// Exacte productnaam in Gripp — zoekt op naam, niet op nummer
// Pas aan als jullie een apart A3-posterproduct aanmaken in Gripp
const NAAM_MAP = {
  A3_POSTER:    'KB Dtf full color transfer high quality A3 formaat',
  VERZENDKOSTEN:'KB Verzendkosten DTF Kobaal',
  AFHALEN:      'KB Afhalen DTF bestelling te Alkmaar',
};

// Prijsstaffel (zelfde als frontend — wordt hier herberekend als backup)
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

// ── Product-IDs ophalen op naam (paginering) ────────────────────────────────
// Identiek aan kobaal-gripp-v22: doorzoekt ALLE producten, stopt pas
// als alle verplichte gevonden zijn of geen pagina's meer.
async function haalProductIds(token) {
  const ids = {};
  const PAGE_SIZE = 250;
  const verplicht = Object.keys(NAAM_MAP);

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
      const naam = String(row.name ?? '').trim();
      for (const [key, zoekNaam] of Object.entries(NAAM_MAP)) {
        if (!ids[key] && naam === zoekNaam) {
          ids[key] = row.id;
          console.log(`✓ ${key}: "${naam}" => id=${row.id}`);
        }
      }
    }

    if (verplicht.every(k => ids[k])) break; // Alle gevonden
    if (rows.length < PAGE_SIZE) break;       // Laatste pagina
  }

  for (const key of verplicht) {
    if (!ids[key]) console.log(`✗ ${key} NIET gevonden ("${NAAM_MAP[key]}")`);
  }
  return ids;
}

// ── Klant zoeken of aanmaken ────────────────────────────────────────────────
// Identiek aan kobaal-gripp-v22: eerst op KVK, dan op e-mail, dan aanmaken
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
    product:      productId,   // getal, NIET object
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
// Aanroepen met { test: true } geeft terug welke producten gevonden worden
// zonder een echte order aan te maken (zelfde als kobaal admin testknop)
async function testVerbinding(token) {
  const ids = await haalProductIds(token);
  const resultaat = {};
  for (const [key, naam] of Object.entries(NAAM_MAP)) {
    resultaat[key] = { naam, gevonden: !!ids[key], gripp_id: ids[key] || null };
  }
  return resultaat;
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

    // Token: uit body (admin) of uit Netlify environment variable
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

    // ── Haal product-IDs op ────────────────────────────────────────────
    const productIds = await haalProductIds(token);
    if (!productIds.A3_POSTER) {
      throw new Error(`A3 poster product "${NAAM_MAP.A3_POSTER}" niet gevonden in Gripp. Controleer de productnaam.`);
    }

    // ── Klant zoeken of aanmaken ───────────────────────────────────────
    const companyId = await zoekOfMaakRelatie(token, klant);

    // ── Prijs berekenen ────────────────────────────────────────────────
    const aantal        = parseInt(bestelling.aantal);
    const prijsPerStuk  = bestelling.prijs_per_stuk ?? getPrijsPerStuk(aantal);
    const verzendkosten = parseFloat(bestelling.verzendkosten ?? 0);
    const methode       = bestelling.verzendmethode ?? 'verzenden'; // 'verzenden' | 'afhalen'
    const ordernummer   = bestelling.ordernummer || `PS-${Date.now()}`;

    // ── Offerteregels bouwen ───────────────────────────────────────────
    const offerlines = [];

    // Regel 1: A3 posters
    const bestandsinfo = bestelling.bestandsnaam ? ` (bestand: ${bestelling.bestandsnaam})` : '';
    offerlines.push(maakRegel(
      productIds.A3_POSTER,
      aantal,
      prijsPerStuk,
      `A3 poster full color${bestandsinfo}`,
    ));

    // Regel 2: Verzendkosten of afhalen
    const verzendKey = methode === 'afhalen' ? 'AFHALEN' : 'VERZENDKOSTEN';
    if (productIds[verzendKey]) {
      offerlines.push(maakRegel(
        productIds[verzendKey],
        1,
        methode === 'afhalen' ? 0 : verzendkosten,
        methode === 'afhalen' ? 'Afhalen te Alkmaar' : `Verzendkosten (${bestelling.verzendland || 'NL'})`,
      ));
    }

    // Regel 3: korting (negatief bedrag) — optioneel
    if (bestelling.korting?.bedrag > 0) {
      offerlines.push(maakRegel(
        productIds.A3_POSTER, // Koppel korting aan hoofdproduct
        1,
        -Math.abs(bestelling.korting.bedrag),
        `Korting${bestelling.korting.code ? ' — ' + bestelling.korting.code : ''}`,
      ));
    }

    // ── Offerte aanmaken in Gripp ──────────────────────────────────────
    const today    = new Date().toISOString().split('T')[0];
    const subject  = `A3 poster order ${ordernummer}`;
    const descRegels = [
      `Bestelling: ${aantal}× A3 poster`,
      `Prijs p/st: €${prijsPerStuk.toFixed(2)}`,
      methode === 'afhalen'
        ? 'Verzending: Afhalen te Alkmaar'
        : `Verzending: €${verzendkosten.toFixed(2)} (${bestelling.verzendland || 'NL'})`,
      bestelling.opmerkingen ? `Opmerking: ${bestelling.opmerkingen}` : '',
      bestelling.bestand_url ? `Bestand: ${bestelling.bestand_url}` : '',
    ].filter(Boolean).join('\n');

    console.log(`Offerte aanmaken: ${offerlines.length} regels, company=${companyId}, order=${ordernummer}`);

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
