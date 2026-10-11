const cheerio = require('cheerio');

const BASE_URL = 'https://seu.consellgeneral.ad/normativaMilloradaAnunciPublic';
const CATEGORIES = [
  { id: 11, type: 'Projecte de llei', label: 'Projectes de llei' },
  { id: 10, type: 'Proposició de llei', label: 'Proposicions de llei' },
  { id: 15, type: 'Projecte de llei qualificada', label: 'Projectes de llei qualificada' }
];
const CACHE_MS = 30 * 60 * 1000;
let cachedResult = null;
let cachedAt = 0;
let inFlight = null;

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

function extractPublicationLinks(html, category) {
  const $ = cheerio.load(html);
  const seen = new Set();
  const publications = [];
  $('a[href*="showPublicacion/"]').each((_, element) => {
    const href = absoluteUrl($(element).attr('href'));
    const match = href && href.match(/showPublicacion\/(\d+)/);
    if (!match || seen.has(match[1])) return;
    seen.add(match[1]);
    publications.push({
      id: match[1],
      title: cleanText($(element).text()),
      url: href,
      ...category
    });
  });
  return publications;
}

function parseDate(text) {
  const match = text.match(/\b(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})\b/);
  if (!match) return null;
  return `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
}

function inferStage(text) {
  const normalized = cleanText(text).toLocaleLowerCase('ca');
  const rules = [
    [/\b(llei\s+\d+\/\d{4}|publicada al bopa|publicació al bopa)\b/, 'Aprovada i publicada'],
    [/\b(aprovat|aprovada|s’aprova|s'aprova)\b/, 'Aprovada pel Consell General'],
    [/\b(desestimat|desestimada|rebutjat|rebutjada|retorn del projecte al govern)\b/, 'Rebutjada o retornada'],
    [/\b(disponible per (a|al|la) sessió|ple del consell|sessió ordinària)\b/, 'Pendent de debat al Ple'],
    [/\b(informe de la (ponència|comissió)|informes de la ponència)\b/, 'En fase d’informes de comissió'],
    [/\b(tramesa|tramès|tramesos) (del |de la |a la |a )?comissió\b/, 'Tramesa a comissió'],
    [/\b(esmenes a la totalitat|esmenes presentades|esmena a la totalitat)\b/, 'Amb esmenes presentades'],
    [/\b(pròrroga|prorroga) al termini\b/, 'Termini d’esmenes prorrogat'],
    [/\b(termini per a la presentació d’esmenes|termini de presentació d’esmenes)\b/, 'Termini d’esmenes obert'],
    [/\b(admissió a tràmit|obertura del termini)\b/, 'Admesa a tràmit']
  ];
  for (const [pattern, stage] of rules) {
    if (pattern.test(normalized)) return stage;
  }
  return 'Publicació parlamentària';
}

function parsePublicationDetail(html, publication) {
  const $ = cheerio.load(html);
  const heading = $('h1, h2, h3, h4').toArray()
    .map(element => cleanText($(element).text()))
    .find(value => /\b(projecte|proposició) de llei\b/i.test(value));
  const title = heading || publication.title || cleanText($('h1').first().text()) || `Iniciativa ${publication.id}`;
  const bodyText = cleanText($('body').text());
  const date = parseDate(bodyText);
  const linkSeen = new Set();
  const documents = [];
  $('a[href]').each((_, element) => {
    const href = absoluteUrl($(element).attr('href'));
    const label = cleanText($(element).text());
    if (!href || !/\.pdf(?:$|\?)/i.test(href) || !label || linkSeen.has(href)) return;
    linkSeen.add(href);
    documents.push({ title: label, url: href });
  });

  const eventCandidates = [];
  $('p, li, .description, .text, h2, h3').each((_, element) => {
    const text = cleanText($(element).text());
    if (text.length >= 20 && text.length <= 700 && /\b(termini|esmen|comissi|trames|informe|aprov|desestim|ple|llei|pròrroga|admissió|publicad|retorn)\b/i.test(text)) {
      eventCandidates.push(text);
    }
  });
  const uniqueEvents = [...new Set(eventCandidates)];
  const lastEvent = uniqueEvents.at(-1) || bodyText.slice(0, 500);

  return {
    id: publication.id,
    title,
    type: publication.type,
    category: publication.label,
    date,
    stage: inferStage(lastEvent),
    latestAction: lastEvent,
    url: publication.url,
    documents: documents.slice(0, 8),
    source: 'Seu Electrònica del Consell General'
  };
}

async function fetchHtml(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'ActualitatJuridicaAndorrana/1.0 (seguiment de publicacions oficials)',
      'Accept-Language': 'ca,es;q=0.8,en;q=0.6'
    },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`La Seu Electrònica ha retornat HTTP ${response.status}`);
  return response.text();
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      try { results[index] = await mapper(items[index]); }
      catch (error) { results[index] = null; }
    }
  });
  await Promise.all(workers);
  return results.filter(Boolean);
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
      url.searchParams.set('max', '20');
      url.searchParams.set('offset', '0');
      url.searchParams.set('tipusRecursivo', 'true');
      const html = await fetchHtml(url.href);
      return extractPublicationLinks(html, category);
    }));

    const failures = categoryResults.filter(result => result.status === 'rejected');
    const publications = categoryResults.flatMap(result => result.status === 'fulfilled' ? result.value : []);
    if (publications.length === 0) {
      throw new Error(failures[0]?.reason?.message || 'No s’han pogut llegir les iniciatives de la Seu Electrònica.');
    }

    const unique = [...new Map(publications.map(item => [item.id, item])).values()];
    const initiatives = await mapWithConcurrency(unique, 6, async publication => {
      const html = await fetchHtml(publication.url);
      return parsePublicationDetail(html, publication);
    });
    initiatives.sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.id.localeCompare(a.id));

    const result = {
      updatedAt: new Date().toISOString(),
      sourceUrl: `${BASE_URL}/categories?tipusId=11`,
      categoriesChecked: CATEGORIES.map(({ id, label }) => ({ id, label, available: categoryResults.some((entry, index) => index === CATEGORIES.findIndex(item => item.id === id) && entry.status === 'fulfilled') })),
      partial: failures.length > 0,
      initiatives,
      cached: false
    };
    cachedResult = result;
    cachedAt = Date.now();
    return result;
  })().finally(() => { inFlight = null; });

  return inFlight;
}

module.exports = { loadParliamentaryTracking, extractPublicationLinks, parsePublicationDetail, inferStage };
