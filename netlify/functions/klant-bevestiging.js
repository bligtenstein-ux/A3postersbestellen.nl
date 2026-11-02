// netlify/functions/klant-bevestiging.js
// Orderbevestiging naar de KLANT voor a3postersbestellen.nl
//
// Geen eigen endpoint: dit is een helper die save-order.js aanroept, direct
// na de geslaagde INSERT (op dezelfde plek als de interne melding naar
// print@extern.nl). Net als die melding faalt deze mail NOOIT de order:
// fouten worden gelogd en de functie geeft { ok:false } terug.
//
// Gebruik in save-order.js:
//   const { stuurKlantBevestiging } = require('./klant-bevestiging');
//   await stuurKlantBevestiging({
//     resend, from: MAIL_FROM, ordernummer, klant, bestelling,
//     bestandTeGroot,
//   });
//
// Prijzen: de frontend stuurt prijs_per_stuk en verzendkosten EXCL. btw
// (zie updatePrice() in index.html). Totaal incl. btw wordt hier op exact
// dezelfde manier berekend als het besteloverzicht op de site:
//   (som(prijs_per_stuk × aantal) + verzendkosten) × 1,21

const REPLY_TO   = 'print@extern.nl';
const TELEFOON   = '072 567 00 00';
const MERKGROEN  = '#3aaa35';
const DONKER     = '#1e3a5f';
const BTW        = 0.21;

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function euro(n) {
  return '€' + Number(n).toFixed(2).replace('.', ',');
}

function drukzijdeLabel(z) {
  const s = String(z || '').toLowerCase();
  if (s.includes('dubbel') || s === '2' || s.includes('2-zijdig')) return 'dubbelzijdig';
  return 'enkelzijdig';
}

// Adres-object van de frontend: { straat, postcode, plaats, land } — zelfde
// defensieve fallbacks als gripp-order.js.
function adresRegels(a, naam) {
  if (!a || typeof a !== 'object') return [];
  const straat = a.straat || a.straatnaam || a.adres || a.address || '';
  if (!straat) return [];
  const pc = `${a.postcode || a.zipcode || ''} ${a.plaats || a.stad || a.city || ''}`.trim();
  return [naam, straat, pc, a.land || a.country || ''].filter(Boolean);
}

// Eén regel per ontwerp; zonder ontwerpen[] één regel uit `bestelling`.
function bestelRegels(bestelling = {}) {
  const ontwerpen = bestelling.ontwerpen;
  if (Array.isArray(ontwerpen) && ontwerpen.length > 0) {
    return ontwerpen.map((o, i) => ({
      titel: ontwerpen.length > 1 ? `Ontwerp ${i + 1}` : 'A3 poster',
      aantal: parseInt(o.aantal ?? o.qty ?? 0, 10),
      zijde: drukzijdeLabel(o.drukzijde),
      bestand: o.bestandsnaam || o.bestand_naam || '',
      prijsEx: Number(o.prijs_per_stuk),
    }));
  }
  return [{
    titel: 'A3 poster',
    aantal: parseInt(bestelling.aantal ?? 0, 10),
    zijde: drukzijdeLabel(bestelling.drukzijde),
    bestand: bestelling.bestandsnaam || '',
    prijsEx: Number(bestelling.prijs_per_stuk),
  }];
}

// Totalen incl. btw, of null als een prijs ontbreekt (dan tonen we geen bedrag:
// liever geen bedrag dan een verkeerd bedrag).
function totalen(bestelling, regels) {
  if (regels.some(r => !Number.isFinite(r.prijsEx) || !(r.aantal > 0))) return null;
  const subEx  = regels.reduce((s, r) => s + r.prijsEx * r.aantal, 0);
  const shipEx = Number(bestelling.verzendkosten) || 0;
  return {
    sub:   subEx * (1 + BTW),
    ship:  shipEx * (1 + BTW),
    totaal: (subEx + shipEx) * (1 + BTW),
  };
}

function bouwHtml({ ordernummer, klant, bestelling, bestandTeGroot }) {
  const regels = bestelRegels(bestelling);
  const t = totalen(bestelling, regels);
  const totaalAantal = regels.reduce((s, r) => s + (r.aantal || 0), 0);
  const aanhef = klant.naam ? `Beste ${esc(klant.naam)},` : 'Beste klant,';
  const afhalen = bestelling.verzendmethode === 'afhalen';

  const leverNaam = klant.bedrijf || klant.naam || '';
  const lever = adresRegels(klant.afleveradres, klant.afleveradres?.bedrijf || klant.afleveradres?.naam || leverNaam);
  const leverBlok = afhalen
    ? 'Afhalen bij Buro Extern, Berenkoog 11, 1822 BH Alkmaar. We laten je weten wanneer je bestelling klaarstaat.'
    : (lever.length ? lever : adresRegels(klant.adres, leverNaam)).map(esc).join('<br>');

  const rijen = regels.map(r => `
    <tr>
      <td style="padding:10px 0;border-bottom:1px solid #e5e7eb;">
        <strong>${esc(r.titel)}</strong><br>
        <span style="color:#6b7280;font-size:13px;">${r.zijde}, 170 grams Gloss MC${r.bestand ? ' — ' + esc(r.bestand) : ''}</span>
      </td>
      <td style="padding:10px 0;border-bottom:1px solid #e5e7eb;text-align:right;white-space:nowrap;">${r.aantal} st.${t ? '<br><span style="color:#6b7280;font-size:13px;">' + euro(r.prijsEx * r.aantal * (1 + BTW)) + '</span>' : ''}</td>
    </tr>`).join('');

  const totaalRij = t
    ? `<tr><td style="padding:10px 0 0;">Verzendkosten</td>
         <td style="padding:10px 0 0;text-align:right;">${afhalen ? 'n.v.t.' : (t.ship > 0 ? euro(t.ship) : 'Gratis')}</td></tr>
       <tr><td style="padding:8px 0 0;"><strong>Totaal incl. btw</strong></td>
         <td style="padding:8px 0 0;text-align:right;"><strong>${euro(t.totaal)}</strong></td></tr>`
    : `<tr><td style="padding:12px 0 0;"><strong>Totaal</strong></td>
         <td style="padding:12px 0 0;text-align:right;"><strong>${totaalAantal} posters</strong></td></tr>`;

  const weTransferBlok = bestandTeGroot ? `
    <div style="margin:24px 0;padding:16px;border-left:4px solid ${DONKER};background:#f1f5f9;">
      <strong>Actie nodig: stuur je drukbestand na</strong><br>
      Je bestand was te groot om direct mee te sturen. Stuur het via WeTransfer naar
      <a href="mailto:${REPLY_TO}" style="color:${DONKER};">${REPLY_TO}</a> en vermeld
      ordernummer <strong>${esc(ordernummer)}</strong>. We starten met drukken zodra we het bestand hebben.
    </div>` : '';

  return `<!doctype html>
<html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Orderbevestiging ${esc(ordernummer)}</title></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:'Plus Jakarta Sans',Arial,Helvetica,sans-serif;color:#1f2937;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:8px;overflow:hidden;">
  <tr><td style="background:${MERKGROEN};padding:20px 28px;color:#ffffff;">
    <div style="font-size:13px;opacity:.9;">a3postersbestellen.nl</div>
    <div style="font-size:22px;font-weight:700;margin-top:4px;">Bedankt voor je bestelling</div>
  </td></tr>
  <tr><td style="padding:28px;font-size:15px;line-height:1.55;">
    <p style="margin:0 0 14px;">${aanhef}</p>
    <p style="margin:0 0 14px;">We hebben je bestelling goed ontvangen en gaan ermee aan de slag.
      Hieronder vind je een overzicht. Bewaar deze mail; je ordernummer heb je nodig als je contact met ons opneemt.</p>

    <div style="margin:20px 0;padding:14px 16px;background:#f0f9ef;border-radius:6px;">
      Ordernummer: <strong style="font-size:17px;">${esc(ordernummer)}</strong>
    </div>
    ${weTransferBlok}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;">
      ${rijen}
      ${totaalRij}
    </table>

    <h3 style="font-size:15px;margin:28px 0 6px;">${afhalen ? 'Afhalen' : 'Afleveradres'}</h3>
    <p style="margin:0;font-size:14px;color:#374151;">${leverBlok}</p>

    ${bestelling.opmerkingen ? `<h3 style="font-size:15px;margin:22px 0 6px;">Je opmerking</h3>
    <p style="margin:0;font-size:14px;color:#374151;">${esc(bestelling.opmerkingen)}</p>` : ''}

    <p style="margin:28px 0 0;">Klopt er iets niet, of heb je een vraag? Beantwoord deze mail of bel ons op
      ${TELEFOON} (werkdagen). Vermeld altijd je ordernummer.</p>
    <p style="margin:18px 0 0;">Met vriendelijke groet,<br><strong>Buro Extern</strong></p>
  </td></tr>
  <tr><td style="padding:16px 28px;background:#f9fafb;font-size:12px;color:#6b7280;line-height:1.5;">
    Buro Extern B.V. — Berenkoog 11, 1822 BH Alkmaar — ${TELEFOON} — ${REPLY_TO}
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

function bouwTekst({ ordernummer, klant, bestelling, bestandTeGroot }) {
  const t = totalen(bestelling, bestelRegels(bestelling));
  const regels = bestelRegels(bestelling)
    .map(r => `- ${r.titel}: ${r.aantal} st., ${r.zijde}${r.bestand ? ' (' + r.bestand + ')' : ''}`);
  return [
    klant.naam ? `Beste ${klant.naam},` : 'Beste klant,',
    '',
    'We hebben je bestelling bij a3postersbestellen.nl goed ontvangen.',
    `Ordernummer: ${ordernummer}`,
    '',
    ...regels,
    t ? `Verzendkosten: ${t.ship > 0 ? euro(t.ship) : 'Gratis'}` : '',
    t ? `Totaal incl. btw: ${euro(t.totaal)}` : '',
    '',
    bestandTeGroot ? `Let op: stuur je drukbestand via WeTransfer naar ${REPLY_TO} o.v.v. ordernummer ${ordernummer}.\n` : '',
    `Vragen? Beantwoord deze mail of bel ${TELEFOON}. Vermeld je ordernummer.`,
    '',
    'Met vriendelijke groet,',
    'Buro Extern',
  ].filter(l => l !== '').join('\n');
}

async function stuurKlantBevestiging({ resend, from, ordernummer, klant = {}, bestelling = {},
                                       bestandTeGroot = false }) {
  try {
    const to = (klant.email || '').trim();
    if (!resend || !from || !to || !ordernummer) {
      console.warn(`[klant-bevestiging] Overgeslagen — resend=${!!resend} from=${!!from} to="${to}" order=${ordernummer}`);
      return { ok: false, reden: 'ontbrekende gegevens' };
    }
    const data = { ordernummer, klant, bestelling, bestandTeGroot };
    const { data: res, error } = await resend.emails.send({
      from: from.includes('<') ? from.replace(/^[^<]*</, 'Buro Extern | A3 posters <') : `Buro Extern | A3 posters <${from}>`,
      to: [to],
      replyTo: REPLY_TO,
      subject: `Orderbevestiging ${ordernummer} — a3postersbestellen.nl`,
      html: bouwHtml(data),
      text: bouwTekst(data),
    });
    if (error) {
      console.error(`[klant-bevestiging] ✗ Resend-fout voor ${ordernummer}: ${JSON.stringify(error)}`);
      return { ok: false, reden: error.message || 'resend-fout' };
    }
    console.log(`[klant-bevestiging] ✓ Bevestiging ${ordernummer} verstuurd naar ${to} (id=${res?.id})`);
    return { ok: true, id: res?.id };
  } catch (err) {
    console.error(`[klant-bevestiging] ✗ Onverwachte fout voor ${ordernummer}: ${err.message}`);
    return { ok: false, reden: err.message };
  }
}

// ── Interne melding naar print@extern.nl (zelfde opmaak) ────────────────────
// Wordt door stuurOrderMail() in save-order.js als html-deel meegestuurd; de
// bestaande platte tekst blijft het text-deel. Toont wat de printafdeling
// nodig heeft: Gripp-status, bestanden, klantgegevens, prijzen excl. én incl.
function interneOnderwerp(ordernummer, gripp_offerte_id) {
  return `Er is een nieuwe bestelling geplaatst — #${ordernummer}`
    + (gripp_offerte_id ? '' : ' (nog niet in Gripp)');
}

function bouwInterneHtml({ ordernummer, klant = {}, bestelling = {}, gripp_offerte_id, bestandTeGroot }) {
  const regels = bestelRegels(bestelling);
  const t = totalen(bestelling, regels);
  const ontw = Array.isArray(bestelling.ontwerpen) ? bestelling.ontwerpen : [];
  const afhalen = bestelling.verzendmethode === 'afhalen';
  const td = 'padding:8px 0;border-bottom:1px solid #e5e7eb;vertical-align:top;';
  const kop = (s) => `<h3 style="font-size:13px;letter-spacing:.04em;text-transform:uppercase;color:#6b7280;margin:26px 0 8px;">${s}</h3>`;

  const grippBlok = gripp_offerte_id
    ? `<div style="margin:0 0 12px;padding:12px 16px;background:#f0f9ef;border-radius:6px;">
         Staat in Gripp als concept-offerte <strong>#${esc(gripp_offerte_id)}</strong>.</div>`
    : `<div style="margin:0 0 12px;padding:12px 16px;border-left:4px solid #c2410c;background:#fff7ed;">
         <strong>Nog niet in Gripp.</strong> De koppeling is mislukt; de order staat wel veilig in de admin.
         Zet hem daar via de knop <em>Gripp</em> alsnog door.</div>`;

  const weTransferBlok = bestandTeGroot
    ? `<div style="margin:0 0 12px;padding:12px 16px;border-left:4px solid ${DONKER};background:#f1f5f9;">
         <strong>Bestand volgt via WeTransfer.</strong> Het drukbestand was te groot voor directe upload;
         de klant stuurt het naar ${REPLY_TO} o.v.v. #${esc(ordernummer)}.</div>`
    : '';

  const rijen = regels.map((r, i) => {
    const achter = ontw[i]?.bestandsnaam_achter || (i === 0 && !ontw.length ? bestelling.bestandsnaam_achter : '');
    const bestanden = [r.bestand, achter ? 'achter: ' + achter : ''].filter(Boolean).map(esc).join('<br>');
    return `<tr>
      <td style="${td}"><strong>${esc(r.titel)}</strong> — ${r.zijde}<br>
        <span style="color:#6b7280;font-size:13px;">${bestanden || '(geen bestandsnaam)'}</span></td>
      <td style="${td}text-align:right;white-space:nowrap;">${r.aantal} st.${Number.isFinite(r.prijsEx)
        ? `<br><span style="color:#6b7280;font-size:13px;">${euro(r.prijsEx)} p/st excl.</span>` : ''}</td>
    </tr>`;
  }).join('');

  const totaalRijen = t ? `
    <tr><td style="padding:10px 0 0;">Verzendkosten</td>
        <td style="padding:10px 0 0;text-align:right;">${afhalen ? 'Afhalen' : (t.ship > 0 ? euro(t.ship) + ' incl.' : 'Gratis')}</td></tr>
    <tr><td style="padding:6px 0 0;">Totaal excl. btw</td>
        <td style="padding:6px 0 0;text-align:right;">${euro(t.totaal / (1 + BTW))}</td></tr>
    <tr><td style="padding:6px 0 0;"><strong>Totaal incl. btw</strong></td>
        <td style="padding:6px 0 0;text-align:right;"><strong>${euro(t.totaal)}</strong></td></tr>` : '';

  const klantRegels = [
    klant.bedrijf ? `<strong>${esc(klant.bedrijf)}</strong>` : '',
    esc(klant.naam),
    klant.email ? `<a href="mailto:${esc(klant.email)}" style="color:${DONKER};">${esc(klant.email)}</a>` : '',
    klant.telefoon ? `<a href="tel:${esc(String(klant.telefoon).replace(/\s/g, ''))}" style="color:${DONKER};">${esc(klant.telefoon)}</a>` : '',
    klant.kvk ? `KvK ${esc(klant.kvk)}` : '',
  ].filter(Boolean).join('<br>');
  const factuur = adresRegels(klant.adres, '').map(esc).join('<br>');
  const aflever = adresRegels(klant.afleveradres, klant.afleveradres?.bedrijf || klant.afleveradres?.naam || '').map(esc).join('<br>');

  return `<!doctype html>
<html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nieuwe bestelling ${esc(ordernummer)}</title></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:'Plus Jakarta Sans',Arial,Helvetica,sans-serif;color:#1f2937;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:8px;overflow:hidden;">
  <tr><td style="background:${MERKGROEN};padding:20px 28px;color:#ffffff;">
    <div style="font-size:13px;opacity:.9;">a3postersbestellen.nl</div>
    <div style="font-size:22px;font-weight:700;margin-top:4px;">Er is een nieuwe bestelling geplaatst</div>
  </td></tr>
  <tr><td style="padding:28px;font-size:15px;line-height:1.55;">
    <div style="margin:0 0 16px;padding:14px 16px;background:#f9fafb;border-radius:6px;">
      Ordernummer: <strong style="font-size:17px;">${esc(ordernummer)}</strong>
    </div>
    ${grippBlok}
    ${weTransferBlok}
    ${kop('Bestelling')}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;">
      ${rijen}
      ${totaalRijen}
    </table>
    ${bestelling.opmerkingen ? `${kop('Opmerking klant')}<p style="margin:0;font-size:14px;">${esc(bestelling.opmerkingen)}</p>` : ''}
    ${kop('Klant')}
    <p style="margin:0;font-size:14px;">${klantRegels}</p>
    ${kop(aflever ? 'Factuuradres' : (afhalen ? 'Adres (afhalen in Alkmaar)' : 'Adres en aflevering'))}
    <p style="margin:0;font-size:14px;">${factuur || '(niet opgegeven)'}</p>
    ${aflever ? `${kop('Afwijkend afleveradres')}<p style="margin:0;font-size:14px;">${aflever}</p>` : ''}
    <p style="margin:28px 0 0;">
      <a href="https://a3postersbestellen.nl/admin" style="display:inline-block;background:${MERKGROEN};color:#ffffff;text-decoration:none;font-weight:700;padding:11px 20px;border-radius:6px;">Open in de admin</a>
    </p>
    <p style="margin:16px 0 0;font-size:13px;color:#6b7280;">Beantwoorden van deze mail gaat rechtstreeks naar de klant.</p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

module.exports = { stuurKlantBevestiging, bouwHtml, bouwTekst, bouwInterneHtml, interneOnderwerp };
