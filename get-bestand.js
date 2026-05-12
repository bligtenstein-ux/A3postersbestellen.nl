// netlify/functions/get-bestand.js
const { neon } = require('@neondatabase/serverless');

exports.handler = async (event) => {
  const secret = event.headers['x-admin-secret'] || event.queryStringParameters?.secret;
  if (secret !== process.env.ADMIN_SECRET) {
    return { statusCode: 401, body: 'Niet geautoriseerd' };
  }

  const ordernummer = event.queryStringParameters?.ordernummer;
  if (!ordernummer) return { statusCode: 400, body: 'ordernummer verplicht' };

  try {
    const sql = neon(process.env.DATABASE_URL);
    const rows = await sql`
      SELECT bestand_data, bestand_naam, bestand_type
      FROM orders
      WHERE ordernummer = ${ordernummer}
    `;

    if (!rows.length || !rows[0].bestand_data) {
      return { statusCode: 404, body: 'Bestand niet gevonden' };
    }

    const { bestand_data, bestand_naam, bestand_type } = rows[0];

    return {
      statusCode: 200,
      headers: {
        'Content-Type': bestand_type || 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${bestand_naam}"`,
        'Access-Control-Allow-Origin': '*',
      },
      body: bestand_data,
      isBase64Encoded: true,
    };
  } catch (err) {
    return { statusCode: 500, body: 'Download mislukt: ' + err.message };
  }
};
