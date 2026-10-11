const cheerio = require('cheerio');
const https = require('https');
const tls = require('tls');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://seu.consellgeneral.ad/normativaMilloradaAnunciPublic';
const CATEGORIES = [
  { id: 11, type: 'Projecte de llei', label: 'Projectes de llei' },
  { id: 12, type: 'Proposició de llei', label: 'Proposicions de llei' },
  { id: 15, type: 'Projecte de llei qualificada', label: 'Projectes de llei qualificada' },
  { id: 16, type: 'Proposició de llei qualificada', label: 'Proposicions de llei qualificada' }
];
const CACHE_MS = 30 * 60 * 1000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 25000;
const ISSUER_CERT_PATH = path.join(__dirname, 'certs', 'sectigo-dv-r36.pem');
const ISSUER_FINGERPRINT = '8C54C334B66BA4E426772AF4A3F9136C19A1AEC729FDB28C535C07A5A4EF22E0';
let cachedResult = null;
let cachedAt = 0;
let inFlight = null;

// The Seu currently omits this intermediate from its TLS chain. Pinning its
// public CA certificate restores strict chain validation without disabling TLS.
const issuerCertificate = fs.readFileSync(ISSUER_CERT_PATH, 'utf8');
const actualIssuerFingerprint = new (require('crypto').X509Certificate)(issuerCertificate)
  .fingerprint256.replace(/:/g, '');
if (actualIssuerFingerprint !== ISSUER_FINGERPRINT) {
  throw new Error('El certificat intermedi de la Seu Electrònica no coincideix amb la petjada verificada.');
}
const officialAgent = new https.Agent({
  keepAlive: true,
  ca: [...tls.rootCertificates, issuerCertificate]
});

function cleanText(value) {
  return String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function absoluteUrl(href) {
  try {
    const url = new URL(href, `${BASE_URL}/`);
    return url.hostname === 'seu.consellgeneral.ad' && url.protocol === 'https:' ? url.href : null;
  } catch (_) {
    return null;
  }
}

function parseDate(text) {
  const match = String(text || '').match(/\b(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})\b/);
  if (!match) return null;
  return `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
}

function inferStage(text) {
  const normalized = cleanText(text).toLocaleLowerCase('ca');
  const rules = [
    [/\b(desestimat|desestimada|rebutjat|rebutjada|retorn del projecte al govern|retorn del projecte de llei al govern)\b/, 'Retornada o rebutjada'],
    [/\b(llei\s+\d+\/\d{4}|publicada al bopa|publicació al bopa)\b/, 'Aprovada i publicada'],
    [/\b(aprovada pel consell|aprovat pel consell|s’aprova|s'aprova)\b/, 'Aprovada pel Consell General'],
    [/\b(esmenes? a la totalitat|esmena a l’articulat|esmena a l'articulat|esmenes presentades)\b/, 'Amb esmenes presentades'],
    [/\b(pròrroga|prorroga|nou termini.*finalitza|sol·licitada.*termini)\b/, 'Termini d’esmenes prorrogat'],
    [/\b(informe de la (ponència|comissió)|informes de la ponència)\b/, 'En fase d’informes de comissió'],
    [/\b(tramesa|tramès|tramesos|es tramet|es trameten)\b.*\bcomissió\b/, 'Tramesa a comissió'],
    [/\b(disponible per (a|al|la) sessió|ple del consell|sessió ordinària)\b/, 'Pendent de debat al Ple'],
    [/\b(termini per a la presentació d’esmenes|termini de presentació d’esmenes|termini.*esmenes.*finalitza)\b/, 'Termini d’esmenes obert'],
    [/\b(admissió a tràmit|obertura del termini)\b/, 'Admesa a tràmit']
  ];
  for (const [pattern, stage] of rules) {
    if (pattern.test(normalized)) return stage;
  }
  return 'Publicació parlamentària';
}

function parsePublicationListing(html, category) {
  const $ = cheerio.load(html);
  const initiatives = [];

  $('.dElementPublicacioDefecte').each((_, element) => {
    const entry = $(element);
    const title = cleanText(entry.find('.contingut > .titol').first().text());
    const registerHref = absoluteUrl(entry.find('a.registreLink').attr('href'));
    const registerId = registerHref && registerHref.match(/registrePublicacio\/(\d+)/)?.[1];
    if (!title || !registerId || !registerHref) return;

    const events = entry.find('.comentarisPublicacio li').toArray()
      .map(item => cleanText($(item).text()))
      .filter(Boolean);
    const latestAction = events.at(-1) || title;
    const documents = [];
    const seenDocuments = new Set();
    entry.find('.documentsAdjunts a[href]').each((__, link) => {
      const url = absoluteUrl($(link).attr('href'));
      const label = cleanText($(link).find('.pdfTitle').text()) || cleanText($(link).text());
      if (!url || !label || seenDocuments.has(url)) return;
      seenDocuments.add(url);
      documents.push({ title: label, url });
    });

    initiatives.push({
      id: registerId,
      title,
      type: category.type,
      category: category.label,
      date: parseDate(entry.find('.data-registre-publicacions').first().text()),
      stage: inferStage(latestAction),
      latestAction,
      url: registerHref,
      documents: documents.slice(0, 8),
      source: 'Seu Electrònica del Consell General'
    });
  });

  return initiatives;
}

function fetchHtml(url) {
  const target = new URL(url);
  if (target.hostname !== 'seu.consellgeneral.ad' || target.protocol !== 'https:') {
    return Promise.reject(new Error('S’ha bloquejat una URL externa a la Seu Electrònica.'));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(value);
    };
    const request = https.get(target, {
      agent: officialAgent,
      headers: {
        'User-Agent': 'ActualitatJuridicaAndorrana/1.0 (seguiment de publicacions oficials)',
        'Accept-Language': 'ca,es;q=0.8,en;q=0.6',
        'Accept-Encoding': 'gzip, deflate, br'
      }
    }, response => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        finish(new Error(`La Seu Electrònica ha retornat HTTP ${response.statusCode}.`));
        return;
      }

      const encoding = String(response.headers['content-encoding'] || '').toLowerCase();
      let body = response;
      if (encoding === 'gzip') body = response.pipe(zlib.createGunzip());
      else if (encoding === 'deflate') body = response.pipe(zlib.createInflate());
      else if (encoding === 'br') body = response.pipe(zlib.createBrotliDecompress());
      else if (encoding && encoding !== 'identity') {
        response.destroy();
        finish(new Error(`La Seu ha utilitzat una compressió no compatible: ${encoding}.`));
        return;
      }

      const chunks = [];
      let bytes = 0;
      body.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          finish(new Error('La resposta de la Seu supera la mida màxima admesa.'));
          body.destroy();
          return;
        }
        chunks.push(chunk);
      });
      body.on('end', () => finish(null, Buffer.concat(chunks).toString('utf8')));
      body.on('error', error => finish(error));
    });

    timeout = setTimeout(() => request.destroy(new Error('La Seu Electrònica ha trigat massa a respondre.')), REQUEST_TIMEOUT_MS);
    request.on('error', error => finish(error));
  });
}

async function loadParliamentaryTracking({ refresh = false } = {}) {
  if (!refresh && cachedResult && Date.now() - cachedAt < CACHE_MS) {
    return { ...cachedResult, cached: true };
  }
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const categoryResults = await Promise.allSettled(CATEGORIES.map(async category => {
      const url = new URL(`${BASE_URL}/categories`);
      url.searchParams.set('tipusId', String(category.id));
      url.searchParams.set('max', '10');
      url.searchParams.set('offset', '0');
      url.searchParams.set('tipusRecursivo', 'true');
      const html = await fetchHtml(url.href);
      return parsePublicationListing(html, category);
    }));

    const failures = categoryResults.filter(result => result.status === 'rejected');
    const initiatives = categoryResults.flatMap(result => result.status === 'fulfilled' ? result.value : []);
    if (initiatives.length === 0) {
      throw new Error(failures[0]?.reason?.message || 'La Seu no ha retornat publicacions legislatives recents.');
    }

    const unique = [...new Map(initiatives.map(item => [item.id, item])).values()];
    unique.sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.id.localeCompare(a.id));

    const result = {
      updatedAt: new Date().toISOString(),
      sourceUrl: `${BASE_URL}/categories?tipusId=11`,
      categoriesChecked: CATEGORIES.map((category, index) => ({
        id: category.id,
        label: category.label,
        available: categoryResults[index].status === 'fulfilled'
      })),
      partial: failures.length > 0,
      initiatives: unique,
      cached: false
    };
    cachedResult = result;
    cachedAt = Date.now();
    return result;
  })().finally(() => { inFlight = null; });

  return inFlight;
}

module.exports = { loadParliamentaryTracking, parsePublicationListing, inferStage };
