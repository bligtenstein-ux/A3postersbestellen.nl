// netlify/functions/gripp-diag.js
// TIJDELIJK DIAGNOSE-SCRIPT — verwijder na gebruik.
//
// Doel: uitzoeken waarom bestaande klanten niet gevonden worden, waardoor elke
// order een duplicaat-relatie aanmaakt. Test meerdere zoekmethodes/velden tegen
// Gripp en geeft de RUWE responses terug, zodat we niet hoeven te gokken.
//
// Gebruik (nadat gedeployed):
//   https://a3postersbestellen.nl/.netlify/functions/gripp-diag?email=bligtenstein@gmail.com
// Optioneel een bekend company-id om de veldstructuur te zien:
//   ...&id=12195
//
// De token loopt via de bestaande GRIPP_API_TOKEN env var — niets gevoeligs in de URL.

const GRIPP_API = 'https://api.gripp.com/public/api3.php';

async function gripp(token, calls) {
  const resp = await fetch(GRIPP_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(calls),
  });
  const status = resp.status;
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* laat json null */ }
  return { status, json, raw: text.slice(0, 2000) };
}

// Voert één test uit en vangt fouten netjes op, zodat één mislukte call de rest
// niet blokkeert. We geven telkens terug: hoeveel rijen gevonden + de ruwe respons.
async function test(naam, token, calls) {
  try {
    const r = await gripp(token, calls);
    const result = r.json?.[0]?.result;
    const rows = result?.rows;
    return {
      test: naam,
      http_status: r.status,
      aantal_rijen: Array.isArray(rows) ? rows.length : (rows === undefined ? 'geen rows-veld' : 'onbekend'),
      eerste_rij_id: Array.isArray(rows) && rows[0] ? rows[0].id : null,
      // Compacte weergave van het resultaat; volledige raw alleen als er iets misging.
      result_keys: result && typeof result === 'object' ? Object.keys(result) : null,
      error_in_response: r.json?.[0]?.error || r.json?.[0]?.error_text || null,
    };
  } catch (err) {
    return { test: naam, fout: err.message };
  }
}

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json' };
  const token = process.env.GRIPP_API_TOKEN || '';
  if (!token) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'GRIPP_API_TOKEN niet ingesteld' }) };
  }

  const email = (event.queryStringParameters?.email || '').trim();
  const id = (event.queryStringParameters?.id || '').trim();
  const offerteParam = (event.queryStringParameters?.offerte || '').trim();

  if (!email && !id && !offerteParam) {
    return {
      statusCode: 400, headers,
      body: JSON.stringify({ error: 'Geef minstens één van ?email=... &id=... &offerte=... mee' }),
    };
  }

  const resultaten = [];

  if (email) {
    // Variant 1: company.search met filter-array (huidige methode in gripp-order.js)
    resultaten.push(await test('search_email_filterarray', token, [{
      method: 'company.search',
      params: [[{ field: 'company.email', operator: 'equals', value: email }], {}, 1, 0],
      id: 1,
    }]));

    // Variant 2: company.get met filters (get is de standaard v3-lees-methode)
    resultaten.push(await test('get_email_filters', token, [{
      method: 'company.get',
      params: [
        [{ field: 'company.email', operator: 'equals', value: email }],
        { paging: { firstresult: 0, maxresults: 5 } },
      ],
      id: 1,
    }]));

    // Variant 3: company.get met 'like' i.p.v. equals (voor het geval hoofdletters/spaties)
    resultaten.push(await test('get_email_like', token, [{
      method: 'company.get',
      params: [
        [{ field: 'company.email', operator: 'like', value: '%' + email + '%' }],
        { paging: { firstresult: 0, maxresults: 5 } },
      ],
      id: 1,
    }]));
  }

  // Als een id is meegegeven: haal die company op en toon de VOLLEDIGE rij,
  // zodat we zien welke adresveldnamen Gripp zelf gebruikt (address/zipcode/city
  // vs visitingaddress_*) en of ze gevuld zijn. Dit beslecht de veldnaam-vraag
  // definitief tegen jouw eigen data.
  if (id) {
    try {
      const r = await gripp(token, [{
        method: 'company.get',
        params: [
          [{ field: 'company.id', operator: 'equals', value: parseInt(id) }],
          { paging: { firstresult: 0, maxresults: 1 } },
        ],
        id: 1,
      }]);
      const row = r.json?.[0]?.result?.rows?.[0];
      // Filter: toon alleen velden waarvan de naam met adres/address/visiting/
      // zip/city/street/postal te maken heeft, plus email/identity — zo zien we
      // precies welke adresvelden bestaan en gevuld zijn.
      let adresVelden = null;
      if (row) {
        adresVelden = {};
        for (const [k, v] of Object.entries(row)) {
          if (/address|zip|city|street|postal|straat|plaats|land|country|identity|email/i.test(k)) {
            adresVelden[k] = v;
          }
        }
      }
      resultaten.push({
        test: 'company_ophalen_op_id',
        http_status: r.status,
        gevonden: !!row,
        adres_en_identity_velden: adresVelden,
        alle_veldnamen: row ? Object.keys(row) : null,
      });
    } catch (err) {
      resultaten.push({ test: 'company_ophalen_op_id', fout: err.message });
    }
  }

  // Als een ordernummer/offerte is meegegeven: haal de offerte op en toon het
  // identity-veld. a3-offertes komen onder de JUISTE identiteit binnen (via
  // template 40), dus dit onthult het correcte identity-ID zonder gokken.
  if (offerteParam) {
    try {
      // Zoek op naam/subject die het ordernummer bevat (bv. "PS-78636").
      const r = await gripp(token, [{
        method: 'offer.get',
        params: [
          [{ field: 'offer.searchname', operator: 'like', value: '%' + offerteParam + '%' }],
          { paging: { firstresult: 0, maxresults: 1 } },
        ],
        id: 1,
      }]);
      const row = r.json?.[0]?.result?.rows?.[0];
      resultaten.push({
        test: 'offerte_ophalen_identity',
        http_status: r.status,
        gevonden: !!row,
        identity: row ? row.identity : null,
        template: row ? (row.template ?? row.templateset) : null,
        offerte_naam: row ? (row.name || row.subject) : null,
      });
    } catch (err) {
      resultaten.push({ test: 'offerte_ophalen_identity', fout: err.message });
    }
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      uitleg: 'company_ophalen_op_id toont welke adresveldnamen Gripp ECHT gebruikt ' +
              '(address/zipcode/city vs visitingaddress_*) — kijk welke gevuld zijn. ' +
              'offerte_ophalen_identity toont het juiste identity-ID (via een bestaande a3-offerte). ' +
              'De search/get-tests tonen welke zoekmethode bestaande klanten vindt.',
      email_getest: email || null,
      id_getest: id || null,
      offerte_getest: offerteParam || null,
      resultaten,
    }, null, 2),
  };
};
