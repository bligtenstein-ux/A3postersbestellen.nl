// netlify/functions/get-bestand.js
// Downloadt een printbestand uit Netlify Blobs — beveiligd

const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  const secret = event.headers['x-admin-secret'] || event.queryStringParameters?.secret;
  if (secret !== process.env.ADMIN_SECRET) {
    return { statusCode: 401, body: 'Niet geautoriseerd' };
  }

  const key = event.queryStringParameters?.key;
  if (!key) return { statusCode: 400, body: 'key verplicht' };

  try {
    const store = getStore('bestanden');
    const { data, metadata } = await store.getWithMetadata(key);
    if (!data) return { statusCode: 404, body: 'Bestand niet gevonden' };

    const buffer = Buffer.from(await data.arrayBuffer());
    const naam = metadata?.naam || key.split('/').pop();
    const type = metadata?.type || 'application/octet-stream';

    return {
      statusCode: 200,
      headers: {
        'Content-Type': type,
        'Content-Disposition': `attachment; filename="${naam}"`,
        'Access-Control-Allow-Origin': '*',
      },
      body: buffer.toString('base64'),
      isBase64Encoded: true,
    };
  } catch (err) {
    return { statusCode: 500, body: 'Download mislukt: ' + err.message };
  }
};
