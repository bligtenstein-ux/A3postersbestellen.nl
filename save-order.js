// netlify/functions/save-order.js
// Slaat orders op in Netlify Blobs + uploadt printbestand
// Wordt aangeroepen vanuit index.html na succesvolle Gripp koppeling

const { getStore } = require('@netlify/blobs');

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
    const { ordernummer, klant, bestelling, gripp_offerte_id, bestand_data, bestand_naam, bestand_type } = body;

    if (!ordernummer) return { statusCode: 400, headers, body: JSON.stringify({ error: 'ordernummer verplicht' }) };

    const store = getStore('orders');

    // Bestand opslaan in Blobs als dat meegestuurd is
    let bestand_url = null;
    if (bestand_data && bestand_naam) {
      const bestandStore = getStore('bestanden');
      const buffer = Buffer.from(bestand_data, 'base64');
      const bestandKey = `${ordernummer}/${bestand_naam}`;
      await bestandStore.set(bestandKey, buffer, {
        metadata: { naam: bestand_naam, type: bestand_type || 'application/octet-stream', ordernummer },
      });
      bestand_url = bestandKey;
    }

    // Order opslaan
    const order = {
      ordernummer,
      klant,
      bestelling,
      gripp_offerte_id: gripp_offerte_id || null,
      bestand_url,
      bestand_naam: bestand_naam || null,
      status: 'nieuw',
      aangemaakt: new Date().toISOString(),
    };

    await store.setJSON(ordernummer, order);

    // Index bijwerken (lijst van alle ordernummers)
    let index = [];
    try {
      index = await store.get('__index__', { type: 'json' }) || [];
    } catch {}
    index.unshift(ordernummer);
    await store.setJSON('__index__', index);

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, ordernummer }) };

  } catch (err) {
    console.error('save-order fout:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: err.message }) };
  }
};
