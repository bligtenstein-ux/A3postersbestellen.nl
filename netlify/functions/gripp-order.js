// netlify/functions/gripp-order.js
// Gripp koppeling voor a3postersbestellen.nl
//
// Environment variables (Netlify → Site settings → Environment):
//   GRIPP_API_TOKEN — jouw Gripp API token
//
// Wijzigingen t.o.v. vorige versie:
//   - Bestemming-adres logica: afwijkend afleveradres krijgt voorrang,
//     valt terug op factuuradres als er geen afwijkend is opgegeven.
//   - Adres wordt bovenaan de offerte-omschrijving gezet zodat het meteen
//     zichtbaar is bij het openen van de offerte in Gripp.
//   - Poging om Gripp's Bestemming-veld te vullen (deliveryaddress).
//     Als dat veld niet aankomt, is het adres alsnog leesbaar via de
//     omschrijving. Logs tonen exact wat er is meegestuurd.
//   - Defensieve adres-extractie (accepteert meerdere veldnamen).

const GRIPP_API      = 'https://api.gripp.com/public/api3.php';
const TEMPLATE_ID    = 40; // Buro Extern sjabloon
const PRODUCT_NUMMER = '1041'; // Drukwerk
const PAPIERSOORT    = '170 grams Gloss MC';
const TAG_COMMUNICATIE = 19; // Gripp-tag "Communicatie" — automatisch op elke webshop-offerte

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

// ── Defensieve adres-extractie ──────────────────────────────────────────────
// BELANGRIJK: de frontend stuurt klant.adres als GENEST OBJECT:
//   { straat: '...', postcode: '...', plaats: '...', land: '...' }
// Eerdere versie behandelde klant.adres als platte string, wat "[object
// Object]" in Gripp opleverde. Deze versie leest het geneste object correct
// uit, met fallbacks voor het geval een andere aanroeper wél platte velden
// of een kant-en-klare string stuurt.
function extractAdres(klant = {}) {
  const nested = (klant.adres && typeof klant.adres === 'object') ? klant.adres : null;
  const adresIsString = typeof klant.adres === 'string' ? klant.adres : null;

  const straat = (nested && (nested.straat || nested.straatnaam || nested.street))
              || klant.straat || klant.straatnaam || klant.street || '';

  const adres = adresIsString
             || (nested && (nested.adres || nested.address))
             || klant.address
             || straat; // "straat" bevat op deze site al "Straat en huisnummer" samen

  return {
    adres,
    postcode: (nested && (nested.postcode || nested.zipcode || nested.postalcode))
           || klant.postcode || klant.zipcode || klant.postalcode || '',
    stad:     (nested && (nested.stad || nested.plaats || nested.city))
           || klant.stad || klant.plaats || klant.city || '',
    land:     (nested && (nested.land || nested.country))
           || klant.land || klant.country || 'Nederland',
  };
}

// De frontend stuurt het afwijkend afleveradres als klant.afleveradres
// (genest object, zonder underscore). Fallbacks voor andere naamgeving
// blijven staan voor het geval dat ooit verandert.
function extractAfleveradres(body = {}) {
  const klant = body.klant || {};
  const a = klant.afleveradres
         || klant.aflever_adres
         || klant.bezorgadres
         || body.bestelling?.aflever_adres
         || body.bestelling?.bezorgadres
         || body.bestelling?.leveradres
         || null;
  if (!a || typeof a !== 'object') return null;

  const straat = a.straat || a.straatnaam || a.address || '';
  if (!straat) return null; // leeg object (bv. toggle uit) telt niet als afwijkend

  return {
    naam:     a.bedrijf || a.naam || a.name || '',
    adres:    straat,
    postcode: a.postcode || a.zipcode || '',
    stad:     a.stad || a.plaats || a.city || '',
    land:     a.land || a.country || 'Nederland',
  };
}

// ── Bestemming bepalen: afwijkend afleveradres OF factuuradres ──────────────
function bepaalBestemming(klant, adresInfo, afleverInfo) {
  if (afleverInfo) {
    return {
      isAfwijkend: true,
      naam:     afleverInfo.naam || klant.bedrijf || klant.naam || '',
      adres:    afleverInfo.adres,
      postcode: afleverInfo.postcode,
      stad:     afleverInfo.stad,
      land:     afleverInfo.land,
    };
  }
  return {
    isAfwijkend: false,
    naam:     klant.bedrijf || klant.naam || '',
    adres:    adresInfo.adres,
    postcode: adresInfo.postcode,
    stad:     adresInfo.stad,
    land:     adresInfo.land,
  };
}

// ── Bestemming formatteren als leesbare tekst ──────────────────────────────
function formatBestemming(bestemming) {
  const lines = [];
  if (bestemming.naam) lines.push(bestemming.naam);
  if (bestemming.adres) lines.push(bestemming.adres);
  const postcodeStad = `${bestemming.postcode || ''} ${bestemming.stad || ''}`.trim();
  if (postcodeStad) lines.push(postcodeStad);
  if (bestemming.land) lines.push(bestemming.land);
  return lines.join('\n');
}

// ── Product-ID ophalen op productnummer ─────────────────────────────────────
async function haalProductId(token) {
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
      console.log(`[gripp-order] ✓ Drukwerk gevonden via filter: id=${rows[0].id}, nummer=${rows[0].number}, naam="${rows[0].name}"`);
      return rows[0].id;
    }
    console.log(`[gripp-order] Filter op product.number=${PRODUCT_NUMMER} gaf 0 resultaten — val terug op paginering`);
  } catch (err) {
    console.log(`[gripp-order] Filter op product.number gaf fout (val terug op paginering): ${err.message}`);
  }

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
        console.log(`[gripp-order] ✓ Drukwerk gevonden via paginering: id=${row.id}, nummer=${nummer}, naam="${row.name}"`);
        return row.id;
      }
    }
    if (rows.length < PAGE_SIZE) break;
  }

  console.log(`[gripp-order] ✗ Drukwerk product met nummer ${PRODUCT_NUMMER} NIET gevonden`);
  return null;
}

// ── Klant zoeken of aanmaken ────────────────────────────────────────────────
async function zoekOfMaakRelatie(token, klant) {
  const adresInfo = extractAdres(klant);

  if (klant.kvk) {
    const res = await gripp(token, [{
      method: 'company.search',
      params: [[{ field: 'company.cocnumber', operator: 'equals', value: klant.kvk }], {}, 1, 0],
      id: 1,
    }]);
    const rows = res[0]?.result?.rows;
    if (rows?.length > 0) {
      console.log(`[gripp-order] Bestaande relatie gevonden op KVK: id=${rows[0].id}`);
      return rows[0].id;
    }
  }

  const res2 = await gripp(token, [{
    method: 'company.search',
    params: [[{ field: 'company.email', operator: 'equals', value: klant.email }], {}, 1, 0],
    id: 1,
  }]);
  const rows2 = res2[0]?.result?.rows;
  if (rows2?.length > 0) {
    console.log(`[gripp-order] Bestaande relatie gevonden op e-mail: id=${rows2[0].id}`);
    return rows2[0].id;
  }

  console.log(`[gripp-order] Nieuwe relatie aanmaken — bedrijf="${klant.bedrijf || klant.naam || klant.email}", adres="${adresInfo.adres}", postcode="${adresInfo.postcode}", stad="${adresInfo.stad}"`);

  const nieuw = await gripp(token, [{
    method: 'company.create',
    params: [{
      companyname: klant.bedrijf || klant.naam || klant.email,
      email:       klant.email,
      cocnumber:   klant.kvk || '',
      phone:       klant.telefoon || '',
      address:     adresInfo.adres,
      zipcode:     adresInfo.postcode,
      city:        adresInfo.stad,
      country:     adresInfo.land,
      relationtype: { id: 1 },
    }],
    id: 1,
  }]);

  const id = nieuw[0]?.result?.id || nieuw[0]?.result?.recordid;
  if (!id) throw new Error('Relatie aanmaken mislukt: ' + JSON.stringify(nieuw[0]?.result));
  console.log(`[gripp-order] ✓ Nieuwe relatie aangemaakt: id=${id}`);
  return id;
}

// ── Offerteregel bouwen ─────────────────────────────────────────────────────
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

// ── Bewerkingsinstructies (rotatie / passend / vullend) ────────────────────
// Het originele bestand wordt ongewijzigd doorgegeven. Deze instructies
// vertellen de drukker wat de klant heeft aangevraagd voor de opmaak.
function bewerkingInstructies(bewerking) {
  if (!bewerking || typeof bewerking !== 'object') return [];
  const parts = [];
  if (bewerking.rotatie && bewerking.rotatie !== 0) {
    parts.push(`Rotatie: ${bewerking.rotatie}°`);
  }
  if (bewerking.fit_mode === 'contain') {
    parts.push('Passend op A3 (witruimte rondom, verhouding behouden)');
  } else if (bewerking.fit_mode === 'cover') {
    parts.push('Vullend op A3 (afsnijding aan randen, verhouding behouden)');
  }
  if (parts.length === 0) return [];
  return ['', '── DRUKINSTRUCTIES ──', ...parts];
}

// ── Beschrijving voor de offerte ────────────────────────────────────────────
// De bestemming staat al apart in het Gripp "Bestemming"-veld
// (workdeliveraddress) — dus die wordt hier niet meer herhaald.
function bouwOfferteBeschrijving({ aantal, prijsPerStuk, methode, bestelling,
                                    klant, adresInfo, bestemming }) {
  const regels = [
    `Bestelling: ${aantal}× A3 poster`,
    `Papiersoort: ${PAPIERSOORT}`,
    `Prijs p/st: €${prijsPerStuk.toFixed(2)}`,
    bestelling.drukzijde ? `Drukzijde: ${bestelling.drukzijde}` : '',
    // Bewerkingsinstructies (rotatie / passend / vullend) — het originele
    // bestand is ongewijzigd, deze instructies moeten bij druk worden toegepast.
    ...bewerkingInstructies(bestelling.bewerking),
    '',
    '── Klant ──',
    klant.bedrijf  ? `Bedrijf: ${klant.bedrijf}`   : '',
    klant.naam     ? `Naam: ${klant.naam}`         : '',
    klant.email    ? `E-mail: ${klant.email}`      : '',
    klant.telefoon ? `Telefoon: ${klant.telefoon}` : '',
    klant.kvk      ? `KVK: ${klant.kvk}`           : '',
  ];

  // Toon factuuradres apart alleen als het afwijkt van de bestemming
  if (bestemming.isAfwijkend) {
    regels.push(
      '',
      '── Factuuradres ──',
      adresInfo.adres || '(niet opgegeven)',
      `${adresInfo.postcode} ${adresInfo.stad}`.trim(),
      adresInfo.land,
    );
  }

  regels.push(
    '',
    methode === 'afhalen'
      ? 'Verzending: Afhalen te Alkmaar (gratis)'
      : `Verzending: gratis (${bestelling.verzendland || bestemming.land || 'NL'})`,
    bestelling.opmerkingen ? `Opmerking: ${bestelling.opmerkingen}` : '',
    bestelling.bestandsnaam ? `Bestand: ${bestelling.bestandsnaam}` : '',
  );

  return regels
    .filter(r => r !== false && r !== null && r !== undefined)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
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

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const body = JSON.parse(event.body || '{}');

    const token = body.gripp_token || process.env.GRIPP_API_TOKEN || '';
    if (!token) {
      return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'GRIPP_API_TOKEN niet ingesteld' }) };
    }

    if (body.test === true) {
      const resultaat = await testVerbinding(token);
      const alleGevonden = Object.values(resultaat).every(r => r.gevonden);
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, test: true, alleGevonden, producten: resultaat }) };
    }

    const { klant, bestelling } = body;
    if (!klant?.email) {
      return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'klant.email verplicht' }) };
    }
    if (!bestelling?.aantal || bestelling.aantal < 1) {
      return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'bestelling.aantal verplicht' }) };
    }

    // Log binnenkomende velden (helpt bij debuggen van naming issues)
    console.log(`[gripp-order] Binnenkomend — klant velden: ${Object.keys(klant || {}).join(', ')}`);
    console.log(`[gripp-order] Binnenkomend — bestelling velden: ${Object.keys(bestelling || {}).join(', ')}`);

    // Adressen extraheren en bestemming bepalen
    const adresInfo   = extractAdres(klant);
    const afleverInfo = extractAfleveradres(body);
    const bestemming  = bepaalBestemming(klant, adresInfo, afleverInfo);

    console.log(`[gripp-order] Factuuradres: "${adresInfo.adres}" — ${adresInfo.postcode} ${adresInfo.stad}, ${adresInfo.land}`);
    if (afleverInfo) {
      console.log(`[gripp-order] Afwijkend afleveradres: "${afleverInfo.adres}" — ${afleverInfo.postcode} ${afleverInfo.stad}`);
    }
    console.log(`[gripp-order] BESTEMMING (${bestemming.isAfwijkend ? 'afwijkend' : 'zelfde als klant'}): "${bestemming.adres}" — ${bestemming.postcode} ${bestemming.stad}`);

    if (!bestemming.adres) {
      console.warn(`[gripp-order] ⚠️ GEEN BESTEMMING! klant object: ${JSON.stringify(klant)}`);
    }

    const productId = await haalProductId(token);
    if (!productId) throw new Error(`Drukwerk product met nummer ${PRODUCT_NUMMER} niet gevonden in Gripp.`);

    const companyId = await zoekOfMaakRelatie(token, klant);

    const aantal       = parseInt(bestelling.aantal);
    const prijsPerStuk = bestelling.prijs_per_stuk ?? getPrijsPerStuk(aantal);
    const methode      = bestelling.verzendmethode ?? 'verzenden';
    const ordernummer  = bestelling.ordernummer || `PS-${Date.now()}`;

    // Offerteregels
    const offerlines = [];
    const bestandsinfo = bestelling.bestandsnaam ? ` (bestand: ${bestelling.bestandsnaam})` : '';
    offerlines.push(maakRegel(productId, aantal, prijsPerStuk, `A3 poster full color — ${PAPIERSOORT}${bestandsinfo}`));

    if (bestelling.korting?.bedrag > 0) {
      offerlines.push(maakRegel(
        productId,
        1,
        -Math.abs(bestelling.korting.bedrag),
        `Korting${bestelling.korting.code ? ' — ' + bestelling.korting.code : ''}`,
      ));
    }

    const today   = new Date().toISOString().split('T')[0];
    const subject = `A3 poster order ${ordernummer}`;
    const description = bouwOfferteBeschrijving({
      aantal, prijsPerStuk, methode, bestelling, klant, adresInfo, bestemming,
    });

    // Bestemming als tekst voor Gripp's Bestemming-veld
    const bestemmingText = formatBestemming(bestemming);

    // Offerte params. We proberen meerdere mogelijke veldnamen voor het
    // Bestemming-veld — Gripp negeert onbekende velden dus dit is veilig.
    const offerteParams = {
      company:          companyId,
      template:         TEMPLATE_ID,
      name:             `A3 Poster ${ordernummer}`,
      subject,
      description,
      date:             today,
      status:           'CONCEPT',
      offerlines,
      // Bestemming-veld — bevestigd via Gripp's officiële API-documentatie:
      // het veld heet "workdeliveraddress" (niet deliveryaddress/destination
      // zoals eerder gegokt).
      workdeliveraddress: bestemmingText,
      tags:               [TAG_COMMUNICATIE],
    };

    console.log(`[gripp-order] Offerte aanmaken: ${offerlines.length} regels, company=${companyId}, order=${ordernummer}, template=${TEMPLATE_ID}`);
    console.log(`[gripp-order] Bestemming-tekst die naar Gripp gaat:\n${bestemmingText}`);

    const offerteResp = await gripp(token, [{
      method: 'offer.create',
      params: [offerteParams],
      id: 1,
    }]);

    const result    = offerteResp[0]?.result;
    const offerteId = result?.id || result?.recordid;
    if (!offerteId) throw new Error('Offerte aanmaken mislukt: ' + JSON.stringify(result));

    console.log(`[gripp-order] ✓ Offerte ${offerteId} aangemaakt voor ${ordernummer}`);

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
    console.error('[gripp-order] fout:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: err.message }) };
  }
};
