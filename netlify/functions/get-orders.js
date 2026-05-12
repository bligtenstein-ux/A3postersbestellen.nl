// netlify/functions/get-orders.js
// Haalt orders op voor de admin — beveiligd met ADMIN_SECRET header

const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Secret',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  // Beveiliging
  const secret = event.headers['x-admin-secret'] || event.queryStringParameters?.secret;
  if (secret !== process.env.ADMIN_SECRET) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Niet geautoriseerd' }) };
  }

  try {
    const store = getStore('orders');
    const action = event.queryStringParameters?.action || 'list';

    // Enkel order ophalen
    if (action === 'get') {
      const nr = event.queryStringParameters?.ordernummer;
      if (!nr) return { statusCode: 400, headers, body: JSON.stringify({ error: 'ordernummer verplicht' }) };
      const order = await store.get(nr, { type: 'json' });
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, order }) };
    }

    // Status updaten
    if (action === 'update_status' && event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const order = await store.get(body.ordernummer, { type: 'json' });
      if (!order) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Order niet gevonden' }) };
      order.status = body.status;
      order.gripp_offerte_id = body.gripp_offerte_id || order.gripp_offerte_id;
      await store.setJSON(body.ordernummer, order);
      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }

    // Lijst van alle orders
    let index = [];
    try {
      index = await store.get('__index__', { type: 'json' }) || [];
    } catch {}

    const orders = [];
    for (const nr of index.slice(0, 200)) {
      try {
        const order = await store.get(nr, { type: 'json' });
        if (order) orders.push(order);
      } catch {}
    }

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, orders }) };

  } catch (err) {
    console.error('get-orders fout:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: err.message }) };
  }
};
