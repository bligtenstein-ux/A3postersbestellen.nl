// netlify/functions/save-order.js
const { getDeployStore } = require('@netlify/blobs');

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

    // Bestand opslaan
    let bestand_url = null;
    if (bestand_data && bestand_naam) {
      const bestandStore = getDeployStore('bestanden');
      const buffer = Buffer.from(bestand_data, 'base64');
      const bestandKey = `${ordernummer}___${bestand_naam}`;
      await bestandStore.set(bestandKey, buffer, {
        metadata: { naam: bestand_naam, type: bestand_type || 'application/octet-stream', ordernummer },
      });
      bestand_url = bestandKey;
    }

    // Order opslaan
    const orderStore = getDeployStore('orders');
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
    await orderStore.setJSON(ordernummer, order);

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, ordernummer }) };

  } catch (err) {
    console.error('save-order fout:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: err.message }) };
  }
};
