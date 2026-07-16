require('dotenv').config();
const express = require('express');
const cheerio = require('cheerio');
const https = require('https');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');

const ai = process.env.GEMINI_API_KEY && process.env.DISABLE_AI !== 'true'
  ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
  : null;

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '16kb' }));
const PORT = process.env.PORT || 3000;

// In-memory cache for news feed data
let newsCache = null;
let cacheTimestamp = null;
let sourceHealthCache = [];
const CACHE_DURATION = 60 * 60 * 1000; // 1 hour in milliseconds

// Cache summaries independently for each practice-area edition.
const aiSummaryCache = new Map();
const subscriptionAttempts = new Map();
const SUBSCRIPTION_RATE_WINDOW = 60 * 60 * 1000;
const SUBSCRIPTION_RATE_LIMIT = 5;

const BOPA_API_BASE = 'https://bopaazurefunctions.azurewebsites.net';
const BOPA_FUNCTION_CODE = (process.env.BOPA_FUNCTION_CODE || '').trim();
const BOPA_DOCUMENTS_ENDPOINT = BOPA_FUNCTION_CODE
  ? `${BOPA_API_BASE}/api/GetDocumentsByBOPA?code=${encodeURIComponent(BOPA_FUNCTION_CODE)}`
  : `${BOPA_API_BASE}/api/GetDocumentsByBOPA`;
const LEGAL_PRACTICE_AREAS = [
  'Penal i seguretat',
  'Laboral i immigració',
  'Fiscal i duaner',
  'Mercantil i societari',
  'Habitatge i urbanisme',
  'Administratiu i contractació pública',
  'Protecció de dades i digital',
  'Financer i assegurances',
  'Unió Europea i internacional',
  'Justícia i procediment',
  'Família i persona',
  'Salut i professions regulades',
  'Educació',
  'General i institucional'
];

function getEmailSubscriptionConfig() {
  const webhookUrl = (process.env.SUBSCRIPTION_WEBHOOK_URL || '').trim();
  const privacyUrl = (process.env.PRIVACY_POLICY_URL || '').trim();
  const isAllowedUrl = (value, allowLocalhost = false) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' || (allowLocalhost && url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname));
    } catch (error) {
      return false;
    }
  };

  return {
    enabled: isAllowedUrl(webhookUrl, process.env.NODE_ENV !== 'production') && isAllowedUrl(privacyUrl),
    webhookUrl,
    privacyUrl: isAllowedUrl(privacyUrl) ? privacyUrl : null
  };
}

function normalizeSubscriptionRequest(body = {}) {
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const practiceArea = typeof body.practiceArea === 'string' && body.practiceArea.trim()
    ? body.practiceArea.trim()
    : 'all';
  const relevance = body.relevance === 'high' ? 'high' : 'all';

  if (body.website) return { isBot: true };
  if (body.consent !== true) throw new Error('Cal acceptar la política de privacitat.');
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Introdueix una adreça electrònica vàlida.');
  }
  if (practiceArea !== 'all' && !LEGAL_PRACTICE_AREAS.includes(practiceArea)) {
    throw new Error('Àrea de pràctica no reconeguda.');
  }

  return { email, practiceArea, relevance, isBot: false };
}

function checkSubscriptionRateLimit(ip) {
  const now = Date.now();
  if (subscriptionAttempts.size > 1000) {
    for (const [key, attempts] of subscriptionAttempts) {
      if (!attempts.some(timestamp => now - timestamp < SUBSCRIPTION_RATE_WINDOW)) {
        subscriptionAttempts.delete(key);
      }
    }
  }
  const recentAttempts = (subscriptionAttempts.get(ip) || []).filter(timestamp => now - timestamp < SUBSCRIPTION_RATE_WINDOW);
  if (recentAttempts.length >= SUBSCRIPTION_RATE_LIMIT) return false;
  recentAttempts.push(now);
  subscriptionAttempts.set(ip, recentAttempts);
  return true;
}

// Map Catalan month names to numbers (0-11)
const CATALAN_MONTHS = {
  'gener': 0, 'febrer': 1, 'març': 2, 'abril': 3, 'maig': 4, 'juny': 5,
  'juliol': 6, 'agost': 7, 'setembre': 8, 'octubre': 9, 'novembre': 10, 'desembre': 11
};

// Helper function to parse Catalan date strings into ISO format
function parseCatalanDate(dateStr) {
  if (!dateStr) return null;
  
  // Format: "12/07/2026" or "12-07-2026"
  const regexSlash = /(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/;
  const matchSlash = dateStr.match(regexSlash);
  if (matchSlash) {
    const day = matchSlash[1].padStart(2, '0');
    const month = matchSlash[2].padStart(2, '0');
    const year = matchSlash[3];
    return `${year}-${month}-${day}`;
  }

  // Format: "Yaounde (Camerun), 12 de juliol del 2026" or "30 d'abril del 2026" or "11 de juny a les 2026"
  const cleanedStr = dateStr.toLowerCase().replace(/,/g, ' ');
  const regexText = /(\d{1,2})\s+(de|d’|d')\s*([a-zç]+)(?:\s+(del|de|a les))?\s+(\d{4})/;
  const matchText = cleanedStr.match(regexText);
  if (matchText) {
    const day = matchText[1].padStart(2, '0');
    const monthName = matchText[3];
    const year = matchText[5];
    const monthIndex = CATALAN_MONTHS[monthName];
    if (monthIndex !== undefined) {
      const month = String(monthIndex + 1).padStart(2, '0');
      return `${year}-${month}-${day}`;
    }
  }

  // Try standard JS Date parsing
  try {
    const parsed = new Date(dateStr);
    if (!isNaN(parsed.getTime())) {
      return parsed.toISOString().split('T')[0];
    }
  } catch (e) {
    // Ignore error and fall back
  }

  // An unknown date must never be presented as if it were published today.
  return null;
}

function decodeBopaText(value = '') {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' ')).replace(/\s+/g, ' ').trim();
  } catch (error) {
    return value.replace(/\+/g, ' ').replace(/\s+/g, ' ').trim();
  }
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildLegalRss(items, generatedAt, options = {}) {
  const selectedArea = options.area || null;
  const highRelevanceOnly = options.relevance === 'high';
  const legalItems = items
    .filter(item =>
      item.isLegislative !== false &&
      item.legalRelevance !== 'low' &&
      (!selectedArea || item.practiceArea === selectedArea) &&
      (!highRelevanceOnly || item.legalRelevance === 'high')
    )
    .slice(0, 75);
  const channelUrl = options.channelUrl || 'https://rssand-production.up.railway.app/';
  const filterLabels = [
    selectedArea,
    highRelevanceOnly ? 'impacte jurídic alt' : null
  ].filter(Boolean);
  const titleSuffix = filterLabels.length ? ` · ${filterLabels.join(' · ')}` : '';
  const descriptionSuffix = filterLabels.length
    ? ` Selecció personalitzada: ${filterLabels.join(', ')}.`
    : '';
  const entries = legalItems.map(item => `
    <item>
      <title>${escapeXml(item.title)}</title>
      <link>${escapeXml(item.link)}</link>
      <guid isPermaLink="true">${escapeXml(item.link)}</guid>
      <pubDate>${new Date(`${item.date}T12:00:00Z`).toUTCString()}</pubDate>
      <category>${escapeXml(item.category || 'Actualitat jurídica')}</category>
      <category>${escapeXml(item.documentType || 'Actualitat oficial')}</category>
      <category>${escapeXml(item.practiceArea || 'General i institucional')}</category>
      <source url="${escapeXml(item.link)}">${escapeXml(item.source || 'Font oficial')}</source>
      <description>${escapeXml([
        item.snippet || 'Consulteu la publicació oficial.',
        item.affectedProfiles ? `Pot interessar a: ${item.affectedProfiles}.` : null,
        item.professionalAction ? `Revisió suggerida: ${item.professionalAction}` : null,
        item.entryIntoForce ? `Entrada en vigor indicada al document: ${item.entryIntoForce}` : null,
        item.operativeDeadlines?.length ? `Possibles terminis literals: ${item.operativeDeadlines.join(' ')}` : null
      ].filter(Boolean).join(' '))}</description>
    </item>
  `).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${escapeXml(`Andorra Legal Brief${titleSuffix}`)}</title>
    <link>${escapeXml(channelUrl)}</link>
    <description>${escapeXml(`Novetats legislatives i reguladores de fonts oficials d'Andorra per a la pràctica jurídica.${descriptionSuffix}`)}</description>
    <language>ca</language>
    <lastBuildDate>${new Date(generatedAt).toUTCString()}</lastBuildDate>
    <generator>Andorra Legal Brief</generator>
    ${entries}
  </channel>
</rss>`;
}

function getLegalRelevance(title = '', category = '') {
  const text = `${title} ${category}`.toLowerCase();
  const highKeywords = [
    'llei', 'reglament', 'decret', 'codi', 'tractat', 'conveni internacional',
    'sentència', 'aute', 'jurisprud', 'constitucional', 'correcció d’errata',
    "correcció d'errata"
  ];
  const mediumKeywords = [
    'edicte', 'resolució', 'autorització', 'quota', 'concurs públic', 'subvenció',
    'ajut', 'fiscal', 'tribut', 'impost', 'habitatge', 'immigració', 'laboral',
    'protecció de dades', 'sanció', 'nacionalitat', 'administració de justícia',
    'regulació', "acord d'associació", 'acord d’associació', 'unió europea'
  ];

  if (highKeywords.some(keyword => text.includes(keyword))) return 'high';
  if (mediumKeywords.some(keyword => text.includes(keyword))) return 'medium';
  return 'low';
}

function getDocumentType(title = '', category = '') {
  const text = `${title} ${category}`.toLowerCase();
  const types = [
    ['Projecte de llei', ['projecte de llei']],
    ['Proposició de llei', ['proposició de llei']],
    ['Llei', ['llei ', 'lleis']],
    ['Reglament', ['reglament']],
    ['Decret', ['decret']],
    ['Sentència / Aute', ['sentència', 'aute', 'jurisprud']],
    ['Resolució', ['resolució']],
    ['Aprovació parlamentària', ['aprova la modificació', 'aprovat el projecte', 'aprovada la llei']],
    ['Edicte', ['edicte']],
    ['Avís', ['avís']],
    ['Informe', ['informe']],
    ['Comunicat', ['comunicat']]
  ];
  const match = types.find(([, keywords]) => keywords.some(keyword => text.includes(keyword)));
  return match ? match[0] : 'Actualitat oficial';
}

function selectEditorialItems(items, limit = 24) {
  const relevanceRank = { high: 3, medium: 2, low: 1 };
  const groups = new Map();
  const sortedItems = [...items].sort((a, b) => {
    const relevanceDifference = (relevanceRank[b.legalRelevance] || 0) - (relevanceRank[a.legalRelevance] || 0);
    if (relevanceDifference !== 0) return relevanceDifference;
    const deadlineDifference = Number(Boolean(b.operativeDeadlines?.length)) - Number(Boolean(a.operativeDeadlines?.length));
    if (deadlineDifference !== 0) return deadlineDifference;
    return new Date(b.date) - new Date(a.date);
  });

  for (const item of sortedItems) {
    const key = item.sourceId || item.source || 'other';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  const selected = [];
  let round = 0;
  while (selected.length < limit) {
    let addedInRound = false;
    for (const sourceItems of groups.values()) {
      if (sourceItems[round]) {
        selected.push(sourceItems[round]);
        addedInRound = true;
        if (selected.length === limit) break;
      }
    }
    if (!addedInRound) break;
    round += 1;
  }
  return selected;
}

function buildDeterministicSummary(weeklyNews, newsForPrompt, reason = null, practiceArea = 'all') {
  const countBy = field => weeklyNews.reduce((counts, item) => {
    const value = item[field] || 'General';
    counts[value] = (counts[value] || 0) + 1;
    return counts;
  }, {});
  const topEntries = counts => Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ca'));
  const topAreas = topEntries(countBy('practiceArea')).slice(0, 4);
  const topTypes = topEntries(countBy('documentType')).slice(0, 3);
  const selected = selectEditorialItems(newsForPrompt, 6);
  const areasText = topAreas.map(([name, count]) => `${name} (${count})`).join(', ');
  const typesText = topTypes.map(([name, count]) => `${name} (${count})`).join(', ');

  return {
    timestamp: new Date().toISOString(),
    itemsCount: weeklyNews.length,
    sampledItemsCount: newsForPrompt.length,
    sampledSources: [...new Set(newsForPrompt.map(item => item.sourceId))],
    editorialMode: 'deterministic',
    editorialNote: reason
      ? 'Síntesi automàtica basada exclusivament en metadades oficials; la capa editorial d’IA no estava disponible.'
      : 'Síntesi automàtica basada exclusivament en metadades oficials.',
    practiceArea,
    resumExecutiu: practiceArea === 'all'
      ? `En els darrers set dies s’han identificat ${weeklyNews.length} publicacions oficials amb rellevància jurídica. Les àrees amb més activitat són ${areasText || 'les àrees generals i institucionals'}. Per tipus documental destaquen ${typesText || 'les publicacions oficials generals'}.`
      : `En els darrers set dies s’han identificat ${weeklyNews.length} publicacions oficials amb rellevància jurídica per a l’àrea ${practiceArea}. Per tipus documental destaquen ${typesText || 'les publicacions oficials generals'}.`,
    puntsClau: selected.map(item => item.title),
    categoriesDestacades: topAreas.map(([nom, count]) => ({
      nom,
      explicacio: `${count} ${count === 1 ? 'publicació oficial classificada' : 'publicacions oficials classificades'} en aquesta àrea durant el període.`
    })),
    noticiesAmbImpacte: selected.map(item => ({
      titol: item.title,
      link: item.link,
      impacte: item.entryIntoForce
        ? `${item.professionalAction} El text inclou una clàusula explícita d’entrada en vigor que convé comprovar a la font.`
        : item.professionalAction
    }))
  };
}

function normalizeAiSummary(summary, newsForPrompt, fallback) {
  if (!summary || typeof summary !== 'object') return fallback;
  const officialByLink = new Map(newsForPrompt.map(item => [item.link, item]));
  const officialByTitle = new Map(newsForPrompt.map(item => [item.title, item]));
  const impactItems = Array.isArray(summary.noticiesAmbImpacte)
    ? summary.noticiesAmbImpacte
      .map(item => {
        const official = officialByLink.get(item.link) || officialByTitle.get(item.titol);
        if (!official) return null;
        return {
          titol: official.title,
          link: official.link,
          impacte: typeof item.impacte === 'string' ? item.impacte : fallback.noticiesAmbImpacte.find(entry => entry.link === official.link)?.impacte
        };
      })
      .filter(Boolean)
      .slice(0, 6)
    : [];

  return {
    ...fallback,
    editorialMode: 'ai',
    editorialNote: 'Síntesi editorial assistida per IA a partir exclusivament de les publicacions oficials seleccionades.',
    resumExecutiu: typeof summary.resumExecutiu === 'string' ? summary.resumExecutiu : fallback.resumExecutiu,
    // Keep these two sections strictly traceable: official titles and counted
    // practice areas, without AI paraphrases.
    puntsClau: fallback.puntsClau,
    categoriesDestacades: fallback.categoriesDestacades,
    noticiesAmbImpacte: impactItems.length ? impactItems : fallback.noticiesAmbImpacte
  };
}

function getPracticeArea(item = {}) {
  const text = `${item.title || ''} ${item.snippet || ''} ${item.category || ''} ${item.source || ''}`.toLowerCase();
  const areas = [
    ['Penal i seguretat', ['codi penal', 'delicte', 'penal', 'policia', 'penitenciari', 'violència de gènere', 'violència domèstica']],
    ['Laboral i immigració', ['laboral', 'treball', 'immigració', 'quota especial', 'autorització de residència', 'salari', 'ocupació']],
    ['Fiscal i duaner', ['fiscal', 'tribut', 'impost', 'taxa', 'duana', 'tabac', 'pressupost']],
    ['Mercantil i societari', ['mercantil', 'societ', 'empresa', 'comerç', 'actius digitals', 'blockchain', 'insolvència']],
    ['Habitatge i urbanisme', ['habitatge', 'arrendament', 'lloguer', 'urbanisme', 'immobiliari', 'edifici']],
    ['Administratiu i contractació pública', ['administració', 'adjudicació', 'contracte públic', 'concurs públic', 'funció pública', 'edicte']],
    ['Protecció de dades i digital', ['protecció de dades', 'privacitat', 'ciber', 'intel·ligència artificial', 'digital', 'tecnologia']],
    ['Financer i assegurances', ['afa', 'financer', 'banc', 'asseguran', 'blanqueig', 'ràting', 'rating', 'fmi', 'moody', 'fitch']],
    ['Unió Europea i internacional', ['unió europea', 'acord d’associació', "acord d'associació", 'tractat', 'internacional', 'conveni']],
    ['Justícia i procediment', ['administració de justícia', 'consell superior de la justícia', 'procediment', 'jurisdicció', 'tribunal']],
    ['Família i persona', ['família', 'menor', 'capacitat', 'tutela', 'successió', 'nacionalitat']],
    ['Salut i professions regulades', ['salut', 'sanitari', 'metge', 'farmà', 'professional regulat']],
    ['Educació', ['educació', 'escolar', 'universitat', 'ensenyament', 'pla d’estudis']]
  ];
  const match = areas.find(([, keywords]) => keywords.some(keyword => text.includes(keyword)));
  return match ? match[0] : 'General i institucional';
}

function getProfessionalReview(item = {}) {
  const documentType = item.documentType || getDocumentType(item.title, item.category);
  const practiceArea = item.practiceArea || getPracticeArea(item);
  const affectedProfilesByArea = {
    'Penal i seguretat': 'Despatxos penalistes, compliance i clients sotmesos a obligacions de prevenció',
    'Laboral i immigració': 'Empreses ocupadores, treballadors i assessoria laboral o migratòria',
    'Fiscal i duaner': 'Contribuents, empreses, assessoria fiscal i operadors duaners',
    'Mercantil i societari': 'Societats, administradors, emprenedors i assessoria mercantil',
    'Habitatge i urbanisme': 'Propietaris, arrendataris, promotors i professionals immobiliaris',
    'Administratiu i contractació pública': 'Administracions, licitadors, concessionaris i empleats públics',
    'Protecció de dades i digital': 'Responsables i encarregats del tractament, DPO i proveïdors digitals',
    'Financer i assegurances': 'Entitats supervisades, intermediaris, asseguradores i funcions de compliance',
    'Unió Europea i internacional': 'Empreses amb activitat transfronterera i assessoria internacional',
    'Justícia i procediment': 'Professionals litigadors i parts en procediments judicials',
    'Família i persona': 'Persones, famílies i professionals de dret civil i de família',
    'Salut i professions regulades': 'Professionals sanitaris, centres i col·legis professionals',
    'Educació': 'Centres educatius, docents, alumnat i administracions competents',
    'General i institucional': 'Professionals que segueixen l’activitat normativa i institucional andorrana'
  };

  const reviewByType = {
    'Projecte de llei': {
      legalStage: 'En tramitació',
      professionalAction: 'Monitorar les esmenes i el text final; no tractar el projecte com a dret vigent.'
    },
    'Proposició de llei': {
      legalStage: 'En tramitació',
      professionalAction: 'Monitorar l’admissió, les esmenes i el text final; encara no és dret vigent.'
    },
    'Aprovació parlamentària': {
      legalStage: 'Aprovació parlamentària',
      professionalAction: 'Comprovar la publicació al BOPA, el text definitiu i la data d’entrada en vigor.'
    },
    'Llei': {
      legalStage: item.officialDocument ? 'Publicat al BOPA' : 'Seguiment normatiu',
      professionalAction: 'Revisar l’àmbit d’aplicació, les disposicions transitòries i finals i l’entrada en vigor.'
    },
    'Reglament': {
      legalStage: item.officialDocument ? 'Publicat al BOPA' : 'Seguiment normatiu',
      professionalAction: 'Revisar les obligacions operatives, els terminis d’adaptació i l’entrada en vigor.'
    },
    'Decret': {
      legalStage: item.officialDocument ? 'Publicat al BOPA' : 'Seguiment normatiu',
      professionalAction: 'Identificar destinataris, efectes, terminis i règim transitori al text oficial.'
    },
    'Resolució': {
      legalStage: item.officialDocument ? 'Publicació oficial' : 'Seguiment administratiu',
      professionalAction: 'Comprovar destinataris, efectes, terminis i vies de recurs que constin a la resolució.'
    },
    'Sentència / Aute': {
      legalStage: 'Resolució judicial',
      professionalAction: 'Revisar els fets, la fonamentació, l’abast del criteri i si la resolució és ferma.'
    },
    'Edicte': {
      legalStage: 'Publicació oficial',
      professionalAction: 'Comprovar l’objecte, les persones afectades i qualsevol termini d’actuació o recurs.'
    },
    'Avís': {
      legalStage: 'Avís oficial',
      professionalAction: 'Verificar si l’avís obre, modifica o tanca algun termini rellevant.'
    },
    'Informe': {
      legalStage: 'Criteri o informació institucional',
      professionalAction: 'Valorar el criteri institucional i distingir-lo de les normes jurídicament vinculants.'
    },
    'Comunicat': {
      legalStage: 'Informació institucional',
      professionalAction: 'Fer-ne seguiment i confirmar qualsevol efecte jurídic en la norma o resolució oficial corresponent.'
    },
    'Actualitat oficial': {
      legalStage: 'Seguiment institucional',
      professionalAction: 'Contrastar l’anunci amb el text normatiu o resolutiu oficial abans d’actuar.'
    }
  };

  return {
    legalStage: (reviewByType[documentType] || reviewByType['Actualitat oficial']).legalStage,
    professionalAction: (reviewByType[documentType] || reviewByType['Actualitat oficial']).professionalAction,
    affectedProfiles: affectedProfilesByArea[practiceArea] || affectedProfilesByArea['General i institucional']
  };
}

function extractBopaDocumentSignals(html = '') {
  const $ = cheerio.load(html);
  const clipLiteral = (text, maxLength) => {
    if (text.length <= maxLength) return text;
    const clipped = text.slice(0, maxLength - 1);
    const lastSpace = clipped.lastIndexOf(' ');
    return `${clipped.slice(0, lastSpace > maxLength * 0.7 ? lastSpace : clipped.length).trim()}…`;
  };
  let entryIntoForce = null;
  const operativeDeadlines = [];
  const seenDeadlines = new Set();
  const temporalSignal = /(?:\btermini\s+(?:màxim\s+)?(?:de\s+)?\d+\s+(?:dies?|mesos?|anys?)\b|\bdins\s+(?:dels?|el)\s+\d+\s+(?:dies?|mesos?|anys?)\b|\ba\s+comptar\s+(?:de|des de)\b|\bfins\s+(?:al|el|a la)\b|\babans\s+(?:del|de la)\b|\bno\s+més\s+tard\s+del\b)/i;
  const actionSignal = /\b(?:presentar|presentació|sol·licitar|sol·licitud|recórrer|recurs|interposar|pagar|pagament|comunicar|comunicació|adaptar|adaptació|complir|inscriure|inscripció|formular|al·legacions|candidatures|ofertes|documentació|esmenar|respondre|comparèixer)\b/i;

  $('p, li').each((_, element) => {
    const text = $(element).text().replace(/\s+/g, ' ').trim();
    if (!text || text.length < 25) return;

    if (!entryIntoForce && /\bentr(?:a|arà)\s+en\s+vigor\b/i.test(text)) {
      entryIntoForce = clipLiteral(text, 360);
    }

    if (operativeDeadlines.length >= 2 || !temporalSignal.test(text) || !actionSignal.test(text)) return;
    const normalized = clipLiteral(text, 420);
    const dedupeKey = normalized.toLocaleLowerCase('ca');
    if (!seenDeadlines.has(dedupeKey)) {
      seenDeadlines.add(dedupeKey);
      operativeDeadlines.push(normalized);
    }
  });

  return { entryIntoForce, operativeDeadlines };
}

async function getBopaDocumentSignals(documentUrl) {
  try {
    const response = await fetch(documentUrl);
    if (!response.ok) return { entryIntoForce: null, operativeDeadlines: [] };
    return extractBopaDocumentSignals(await response.text());
  } catch (error) {
    return { entryIntoForce: null, operativeDeadlines: [] };
  }
}

function fetchGovernHtml() {
  return new Promise((resolve, reject) => {
    // govern.ad currently serves a certificate chain that Node rejects while
    // browsers accept it. Keep this exception isolated to this exact host.
    const request = https.get('https://www.govern.ad/ca/actualitat', {
      rejectUnauthorized: false,
      headers: {
        'User-Agent': 'AndorraLegalBrief/1.0 (+https://rssand-production.up.railway.app/)'
      }
    }, response => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`HTTP error Govern: ${response.statusCode}`));
        return;
      }

      response.setEncoding('utf8');
      let html = '';
      response.on('data', chunk => {
        html += chunk;
      });
      response.on('end', () => resolve(html));
    });

    request.setTimeout(30000, () => {
      request.destroy(new Error('Timeout carregant Govern'));
    });
    request.on('error', reject);
  });
}

// Helper to check if a CG article is legislative or cultural/protocol
function getArticleCategory(titleText) {
  const title = titleText.toLowerCase();
  
  const keepKeywords = [
    'llei', 'acord', 'junta de presidents', 'compareix', 'decret', 'normat', 
    'reglament', 'tramit', 'aprov', 'sesió', 'sessió', 'sindic', 'síndic', 'parlament'
  ];
  
  const discardKeywords = [
    'recepció', 'visita', 'exposició', 'cultural', 'protocol', 'concert', 
    'presentació de llibre', 'cos consular', 'llibre', 'apf', 'yaoundé', 
    'camerun', 'premi', 'homenatge', 'escola', 'estudiant', 'visiten'
  ];

  const hasKeep = keepKeywords.some(kw => title.includes(kw));
  const hasDiscard = discardKeywords.some(kw => title.includes(kw));

  if (hasKeep && !hasDiscard) {
    return { isLegislative: true, category: 'Legislatiu / Normatiu' };
  } else if (hasDiscard) {
    return { isLegislative: false, category: 'Cultural / Protocol·lari' };
  } else {
    // Neutral content, tag as general political activity
    return { isLegislative: true, category: 'Activitat Parlamentària' };
  }
}

// SCRAPERS

// 1. Consell General News
async function scrapeConsellGeneralNews() {
  try {
    const response = await fetch('https://www.consellgeneral.ad/ca/noticies');
    if (!response.ok) throw new Error(`HTTP error CG News: ${response.status}`);
    const html = await response.text();
    const $ = cheerio.load(html);
    const items = [];

    $('.tileItem').each((_, el) => {
      const titleLink = $(el).find('h3.tileHeadline a.summary');
      const title = titleLink.text().trim();
      const relativeHref = titleLink.attr('href') || '';
      const link = relativeHref.startsWith('http') ? relativeHref : `https://www.consellgeneral.ad${relativeHref}`;
      
      const dateText = $(el).find('p.tileBody span.description').text().trim();
      const date = parseCatalanDate(dateText);

      const filterResult = getArticleCategory(title);

      if (!title || !link || !date) return;

      items.push({
        source: "Consell General",
        sourceId: "consell_noticies",
        title,
        link,
        date,
        snippet: dateText,
        category: filterResult.category,
        isLegislative: filterResult.isLegislative,
        legalRelevance: getLegalRelevance(title, filterResult.category)
      });
    });

    return items;
  } catch (error) {
    console.error("Error scraping Consell General News:", error.message);
    return [];
  }
}

// 2. APDA RSS Parser
async function scrapeAPDAFeed() {
  try {
    const response = await fetch('https://www.apda.ad/feed');
    if (!response.ok) throw new Error(`HTTP error APDA RSS: ${response.status}`);
    const xml = await response.text();
    const $ = cheerio.load(xml, { xmlMode: true });
    const items = [];

    $('item').each((_, el) => {
      const title = $(el).find('title').text().trim();
      const link = $(el).find('link').text().trim();
      const pubDate = $(el).find('pubDate').text().trim();
      const date = parseCatalanDate(pubDate);
      
      // Clean HTML from description
      const descHtml = $(el).find('description').text().trim();
      const descText = cheerio.load(descHtml).text().replace(/\s+/g, ' ').trim();
      const snippet = descText.length > 200 ? descText.substring(0, 200) + '...' : descText;

      // Filter tags based on titles/description
      let category = "Protecció de Dades";
      const lowerText = (title + ' ' + descText).toLowerCase();
      if (lowerText.includes('ia') || lowerText.includes('intel·ligència artificial') || lowerText.includes('artificial')) {
        category = "IA / Tecnologia";
      } else if (lowerText.includes('sanció') || lowerText.includes('sancion') || lowerText.includes('multa')) {
        category = "Sancions / Resolucions";
      }

      if (!title || !link || !date) return;

      items.push({
        source: "APDA (Dades & IA)",
        sourceId: "apda",
        title,
        link,
        date,
        snippet,
        category,
        isLegislative: true,
        legalRelevance: getLegalRelevance(title, category)
      });
    });

    return items;
  } catch (error) {
    console.error("Error fetching APDA feed:", error.message);
    return [];
  }
}

// 4. Govern d'Andorra — direct official source
async function scrapeGovernNews() {
  try {
    const html = await fetchGovernHtml();
    const $ = cheerio.load(html);
    const items = [];
    const seen = new Set();

    $('.card-new').each((_, el) => {
      const body = $(el).find('.card-body');
      const titleLink = body.find('.card-title a');
      const title = titleLink.text().replace(/\s+/g, ' ').trim();
      const href = titleLink.attr('href') || '';
      const link = href.startsWith('http') ? href : `https://www.govern.ad${href}`;
      const category = body.find('.tag').text().replace(/\s+/g, ' ').trim() || 'Govern';
      const paragraphs = body.find('p.font-s');
      const snippet = paragraphs.first().text().replace(/\s+/g, ' ').trim();
      const dateText = paragraphs.last().text().replace(/\s+/g, ' ').trim();
      const date = parseCatalanDate(dateText);
      const legalRelevance = getLegalRelevance(title, category);

      if (!title || !href || !date || seen.has(link) || legalRelevance === 'low') return;
      seen.add(link);
      items.push({
        source: "Govern d'Andorra",
        sourceId: "govern",
        title,
        link,
        date,
        snippet,
        category,
        isLegislative: true,
        legalRelevance
      });
    });

    return items;
  } catch (error) {
    console.error("Error scraping Govern news:", error.message);
    return [];
  }
}

// 5. Andorra UE Scraper
async function scrapeAndorraUE() {
  try {
    const response = await fetch('https://www.andorraue.ad/ca/actualitat/');
    if (!response.ok) throw new Error(`HTTP error Andorra UE: ${response.status}`);
    const html = await response.text();
    const $ = cheerio.load(html);
    const items = [];

    $('.post-classic').each((_, el) => {
      const titleLink = $(el).find('.post-classic-title a');
      const title = titleLink.text().trim();
      const relativeHref = titleLink.attr('href') || '';
      const link = relativeHref.startsWith('http') ? relativeHref : `https://www.andorraue.ad${relativeHref}`;

      const dateText = $(el).find('.post-classic-time').text().replace(/\s+/g, ' ').trim();
      const date = parseCatalanDate(dateText);

      const snippet = $(el).find('.post-classic-text').text().trim();

      if (!title || !link || !date) return;

      items.push({
        source: "Andorra UE",
        sourceId: "andorra_ue",
        title,
        link,
        date,
        snippet,
        category: "Acord d'Associació",
        isLegislative: true,
        legalRelevance: getLegalRelevance(title, "Acord d'Associació")
      });
    });

    return items;
  } catch (error) {
    console.error("Error scraping Andorra UE:", error.message);
    return [];
  }
}

// 6. AFA Scraper
async function scrapeAFANews() {
  try {
    const response = await fetch('https://www.afa.ad/ca/coneix-lafa/actualitat-afa/comunicats-de-premsa');
    if (!response.ok) throw new Error(`HTTP error AFA: ${response.status}`);
    const html = await response.text();
    const $ = cheerio.load(html);
    const items = [];

    // Press releases links wrap shadowed cards
    $('a').each((_, el) => {
      const href = $(el).attr('href') || '';
      if (href.includes('/comunicats-de-premsa/') && href.endsWith('/view')) {
        const title = $(el).find('.roboto-light-13').text().trim();
        const snippet = $(el).find('.roboto-light-10').text().trim();
        const dateText = $(el).find('.discreet').text().trim(); // e.g. "10/09/2025"
        const date = parseCatalanDate(dateText);

        if (title) {
          if (!date) return;

          items.push({
            source: "AFA (Financer)",
            sourceId: "afa",
            title,
            link: href,
            date,
            snippet: snippet || "Comunicat oficial de premsa emès per l'Autoritat Financera Andorrana.",
            category: "Regulació Financera",
            isLegislative: true,
            legalRelevance: getLegalRelevance(title, "Regulació Financera")
          });
        }
      }
    });

    // Remove duplicates
    const seen = new Set();
    const uniqueItems = [];
    for (const item of items) {
      if (!seen.has(item.link)) {
        seen.add(item.link);
        uniqueItems.push(item);
      }
    }

    return uniqueItems;
  } catch (error) {
    console.error("Error scraping AFA:", error.message);
    return [];
  }
}

// 7. BOPA — official public API and direct official documents
async function scrapeBOPANews() {
  try {
    const bulletinResponse = await fetch(`${BOPA_API_BASE}/api/GetNewPaginatedNewsletter`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sizePage: 4,
        datesList: [],
        skipToken: null,
        anys: [],
        numButlleti: null
      })
    });
    if (!bulletinResponse.ok) throw new Error(`HTTP error BOPA bulletins: ${bulletinResponse.status}`);
    const bulletinData = await bulletinResponse.json();
    const bulletins = Array.isArray(bulletinData.bopaList) ? bulletinData.bopaList : [];

    const documentsByBulletin = await Promise.all(bulletins.map(async bulletin => {
      const date = new Date(bulletin.dataPublicacio);
      const year = date.getUTCFullYear();
      if (!BOPA_FUNCTION_CODE) throw new Error('Missing BOPA_FUNCTION_CODE');
      const url = `${BOPA_DOCUMENTS_ENDPOINT}&numBOPA=${encodeURIComponent(bulletin.numBOPA)}&year=${year}`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP error BOPA ${bulletin.numBOPA}: ${response.status}`);
      const data = await response.json();
      return { bulletin, documents: data.paginatedDocuments || [] };
    }));

    const items = [];
    for (const { bulletin, documents } of documentsByBulletin) {
      const publicationDate = new Date(bulletin.dataPublicacio).toISOString().split('T')[0];
      for (const result of documents) {
        const document = result.document || {};
        const title = decodeBopaText(document.sumari);
        const category = document.organisme || 'Disposicions oficials';
        const legalRelevance = getLegalRelevance(title, category);
        if (!title || !document.metadata_storage_path || legalRelevance === 'low') continue;

        items.push({
          source: `BOPA núm. ${bulletin.numBOPA}${bulletin.isExtra ? ' extraordinari' : ''}`,
          sourceId: "bopa",
          title,
          link: document.metadata_storage_path,
          date: publicationDate,
          snippet: `${category}${document.tema ? ` · ${document.tema}` : ''}. Publicació oficial del ${publicationDate}.`,
          category,
          isLegislative: true,
          legalRelevance,
          documentType: getDocumentType(title, category),
          officialDocument: true,
          bulletinNumber: bulletin.numBOPA
        });
      }
    }

    const selectedItems = items.slice(0, 60);
    const deadlineProneTypes = new Set(['Llei', 'Reglament', 'Decret', 'Resolució', 'Edicte', 'Avís']);
    const itemsToEnrich = selectedItems
      .filter(item => item.legalRelevance === 'high' || deadlineProneTypes.has(item.documentType))
      .slice(0, 36);
    await Promise.all(itemsToEnrich.map(async item => {
      Object.assign(item, await getBopaDocumentSignals(item.link));
    }));

    return selectedItems;
  } catch (error) {
    console.error("Error fetching BOPA official data:", error.message);
    return [];
  }
}

// Serve Frontend Static Files
app.use(express.static(path.join(__dirname, 'public')));

// Helper to fetch and cache all feeds
async function fetchAllFeeds() {
  console.log("Fetching feeds...");
  const sources = [
    { id: 'consell_noticies', name: 'Consell General', url: 'https://www.consellgeneral.ad/ca/noticies', load: scrapeConsellGeneralNews },
    { id: 'apda', name: 'APDA', url: 'https://www.apda.ad', load: scrapeAPDAFeed },
    { id: 'govern', name: "Govern d'Andorra", url: 'https://www.govern.ad/ca/actualitat', load: scrapeGovernNews },
    { id: 'andorra_ue', name: 'Andorra–UE', url: 'https://www.andorraue.ad/ca/actualitat/', load: scrapeAndorraUE },
    { id: 'afa', name: 'AFA', url: 'https://www.afa.ad', load: scrapeAFANews },
    { id: 'bopa', name: 'BOPA', url: 'https://www.bopa.ad', load: scrapeBOPANews }
  ];
  const checkedAt = new Date().toISOString();
  const results = await Promise.allSettled(sources.map(source => source.load()));

  const allItems = [];
  sourceHealthCache = results.map((result, index) => {
    const source = sources[index];
    if (result.status === 'fulfilled') {
      const items = Array.isArray(result.value) ? result.value : [];
      allItems.push(...items);
      const latestItemDate = items
        .map(item => item.date)
        .filter(Boolean)
        .sort()
        .reverse()[0] || null;

      return {
        id: source.id,
        name: source.name,
        url: source.url,
        status: items.length > 0 ? 'ok' : 'warning',
        itemsCount: items.length,
        latestItemDate,
        checkedAt
      };
    } else {
      console.error(`Feed ${source.name} failed to load:`, result.reason);
      return {
        id: source.id,
        name: source.name,
        url: source.url,
        status: 'error',
        itemsCount: 0,
        latestItemDate: null,
        checkedAt
      };
    }
  });

  const seenLinks = new Set();
  const normalizedItems = allItems.filter(item => {
    if (!item || !item.title || !item.link || !item.date || seenLinks.has(item.link)) return false;
    seenLinks.add(item.link);
    item.legalRelevance = item.legalRelevance || getLegalRelevance(item.title, item.category);
    item.documentType = item.documentType || getDocumentType(item.title, item.category);
    item.practiceArea = item.practiceArea || getPracticeArea(item);
    Object.assign(item, getProfessionalReview(item));
    return true;
  });

  // Sort chronologically: newest first
  normalizedItems.sort((a, b) => {
    const dateDifference = new Date(b.date) - new Date(a.date);
    if (dateDifference !== 0) return dateDifference;
    const rank = { high: 3, medium: 2, low: 1 };
    return (rank[b.legalRelevance] || 0) - (rank[a.legalRelevance] || 0);
  });

  newsCache = normalizedItems;
  cacheTimestamp = Date.now();
  aiSummaryCache.clear();
  return normalizedItems;
}

// API Endpoint to get unified news feed
app.get('/api/news', async (req, res) => {
  const forceRefresh = req.query.refresh === 'true';

  if (!forceRefresh && newsCache && cacheTimestamp && (Date.now() - cacheTimestamp < CACHE_DURATION)) {
    return res.json({
      timestamp: new Date(cacheTimestamp).toISOString(),
      cached: true,
      sources: sourceHealthCache,
      items: newsCache
    });
  }

  try {
    const items = await fetchAllFeeds();
    res.json({
      timestamp: new Date(cacheTimestamp).toISOString(),
      cached: false,
      sources: sourceHealthCache,
      items: items
    });
  } catch (err) {
    console.error("Error serving news:", err);
    res.status(500).json({ error: "Error carregant les notícies." });
  }
});

app.get('/api/health', (req, res) => {
  const healthySources = sourceHealthCache.filter(source => source.status === 'ok').length;
  const totalSources = sourceHealthCache.length;
  res.status(totalSources > 0 && healthySources === 0 ? 503 : 200).json({
    status: totalSources > 0 && healthySources === totalSources ? 'ok' : 'degraded',
    timestamp: cacheTimestamp ? new Date(cacheTimestamp).toISOString() : null,
    cachedItems: newsCache ? newsCache.length : 0,
    healthySources,
    totalSources,
    sources: sourceHealthCache
  });
});

app.get('/api/subscriptions/config', (req, res) => {
  const config = getEmailSubscriptionConfig();
  res.set('Cache-Control', 'public, max-age=300');
  res.json({
    emailEnabled: config.enabled,
    privacyUrl: config.privacyUrl
  });
});

app.post('/api/subscriptions', async (req, res) => {
  const config = getEmailSubscriptionConfig();
  if (!config.enabled) {
    return res.status(503).json({ error: 'La subscripció per correu encara no està activada.' });
  }
  if (!checkSubscriptionRateLimit(req.ip || 'unknown')) {
    return res.status(429).json({ error: 'S’han fet massa intents. Torna-ho a provar més tard.' });
  }

  let subscription;
  try {
    subscription = normalizeSubscriptionRequest(req.body);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  // Honeypot submissions receive a neutral response without reaching the provider.
  if (subscription.isBot) return res.status(201).json({ accepted: true });

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (process.env.SUBSCRIPTION_WEBHOOK_TOKEN) {
      headers.Authorization = `Bearer ${process.env.SUBSCRIPTION_WEBHOOK_TOKEN}`;
    }
    const response = await fetch(config.webhookUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        email: subscription.email,
        practiceArea: subscription.practiceArea === 'all' ? null : subscription.practiceArea,
        relevance: subscription.relevance,
        locale: 'ca-AD',
        source: 'andorra-legal-brief-web',
        doubleOptInRequested: true,
        subscribedAt: new Date().toISOString()
      }),
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) throw new Error(`Subscription provider returned ${response.status}`);
    res.status(201).json({
      accepted: true,
      message: 'Revisa el correu i confirma la subscripció.'
    });
  } catch (error) {
    console.error('Subscription provider unavailable:', error.message);
    res.status(502).json({ error: 'No s’ha pogut registrar la subscripció. Torna-ho a provar més tard.' });
  }
});

app.get('/feed.xml', async (req, res) => {
  try {
    let items = newsCache;
    if (!items || !cacheTimestamp || (Date.now() - cacheTimestamp > CACHE_DURATION)) {
      items = await fetchAllFeeds();
    }
    const availableAreas = new Set(items.map(item => item.practiceArea).filter(Boolean));
    const requestedArea = typeof req.query.area === 'string' ? req.query.area.trim() : '';
    if (requestedArea && !availableAreas.has(requestedArea)) {
      return res.status(400).type('text/plain; charset=utf-8').send('Àrea de pràctica no reconeguda.');
    }
    const area = availableAreas.has(requestedArea) ? requestedArea : null;
    const relevance = req.query.relevance === 'high' ? 'high' : 'all';
    const publicBaseUrl = (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
    const query = new URLSearchParams();
    if (area) query.set('area', area);
    if (relevance === 'high') query.set('relevance', 'high');
    const feedUrl = `${publicBaseUrl}/feed.xml${query.size ? `?${query.toString()}` : ''}`;

    res.type('application/rss+xml; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=900');
    res.send(buildLegalRss(items, cacheTimestamp || Date.now(), {
      area,
      relevance,
      channelUrl: feedUrl
    }));
  } catch (error) {
    console.error("Error generant el feed RSS jurídic:", error);
    res.status(500).type('text/plain').send("No s'ha pogut generar el feed RSS.");
  }
});

// Helper function to generate and cache weekly AI Summary
async function getAiSummary(forceRefresh = false, requestedPracticeArea = 'all') {
  const now = Date.now();
  const requestedArea = typeof requestedPracticeArea === 'string' && requestedPracticeArea.trim()
    ? requestedPracticeArea.trim()
    : 'all';
  const cachedSummary = aiSummaryCache.get(requestedArea);
  if (!forceRefresh && cachedSummary && (now - cachedSummary.timestamp < CACHE_DURATION)) {
    return cachedSummary.data;
  }

  let items = newsCache;
  if (forceRefresh || !items || !cacheTimestamp || (now - cacheTimestamp > CACHE_DURATION)) {
    items = await fetchAllFeeds();
  }

  if (!items || items.length === 0) {
    throw new Error("No s'han trobat notícies per realitzar el resum.");
  }

  const availableAreas = new Set(items.map(item => item.practiceArea).filter(Boolean));
  if (requestedArea !== 'all' && !availableAreas.has(requestedArea)) {
    const error = new Error('Àrea de pràctica no reconeguda.');
    error.status = 400;
    throw error;
  }

  // Filter news from the last 7 days
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const limitDateStr = sevenDaysAgo.toISOString().split('T')[0];

  const weeklyNews = items.filter(item =>
    item.date >= limitDateStr &&
    item.legalRelevance !== 'low' &&
    item.isLegislative !== false &&
    (requestedArea === 'all' || item.practiceArea === requestedArea)
  );

  if (weeklyNews.length === 0) {
    const emptySummary = {
      timestamp: new Date().toISOString(),
      itemsCount: 0,
      sampledItemsCount: 0,
      sampledSources: [],
      practiceArea: requestedArea,
      editorialMode: 'deterministic',
      editorialNote: 'No hi ha publicacions suficients en el període seleccionat.',
      resumExecutiu: requestedArea === 'all'
        ? "No hi ha prou notícies publicades en els darrers 7 dies per generar un resum setmanal."
        : `No hi ha prou publicacions de l’àrea ${requestedArea} en els darrers 7 dies per generar un resum setmanal.`,
      puntsClau: [],
      categoriesDestacades: [],
      noticiesAmbImpacte: []
    };
    aiSummaryCache.set(requestedArea, { timestamp: Date.now(), data: emptySummary });
    return emptySummary;
  }

  // Balance the editorial sample so a high-volume source cannot crowd out
  // the rest of the official channels.
  const newsForPrompt = selectEditorialItems(weeklyNews, 24);

  const newsSummaryText = newsForPrompt.map((n, idx) => 
    `[${idx + 1}] Font: ${n.source} | Data: ${n.date} | Tipus: ${n.documentType} | Àrea: ${n.practiceArea}\nTítol: ${n.title}\nDescripció: ${n.snippet || ''}\nEntrada en vigor explícita: ${n.entryIntoForce || 'No identificada al document'}\nPossibles terminis literals: ${n.operativeDeadlines?.join(' | ') || 'No identificats al document'}\nEnllaç: ${n.link || ''}\n`
  ).join('\n---\n');

  const prompt = `Ets l'editor jurídic d'un butlletí professional adreçat a advocats exercents del Principat d'Andorra.
A partir exclusivament de les següents publicacions oficials de la darrera setmana, redacta una síntesi rigorosa, concisa i útil per a la pràctica jurídica, en català.
Edició sol·licitada: ${requestedArea === 'all' ? 'totes les àrees de pràctica' : requestedArea}.

Notícies de la setmana:
${newsSummaryText}

No inventis dates d'entrada en vigor, terminis, obligacions, efectes jurídics ni conclusions que no constin en el material facilitat. Els "possibles terminis literals" són fragments per comprovar, no una determinació jurídica: no n'ampliïs l'abast. Si una dada no es pot determinar, no l'afirmis.
Prioritza lleis, reglaments, decrets, resolucions, jurisprudència, iniciatives legislatives i canvis regulatoris amb impacte professional.
Per a "noticiesAmbImpacte", selecciona fins a 6 publicacions i conserva exactament el títol i l'enllaç originals. Explica en 1 o 2 frases què convé revisar o per què pot ser rellevant per a un despatx, sense donar assessorament jurídic ni extrapolar més enllà de la font.`;

  const fallbackSummary = buildDeterministicSummary(weeklyNews, newsForPrompt, null, requestedArea);
  if (!ai) {
    const summary = buildDeterministicSummary(weeklyNews, newsForPrompt, 'missing_api_key', requestedArea);
    aiSummaryCache.set(requestedArea, { timestamp: Date.now(), data: summary });
    return summary;
  }

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-3.5-flash',
      contents: prompt,
      config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          resumExecutiu: { 
            type: "STRING", 
            description: "Un resum redactat de l'actualitat institucional de la setmana a Andorra, en 1 o 2 paràgrafs." 
          },
          puntsClau: {
            type: "ARRAY",
            items: { type: "STRING" },
            description: "Llista dels 4-6 fets o acords legislatius/normatius més rellevants de la setmana."
          },
          categoriesDestacades: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                nom: { type: "STRING", description: "Nom del sector destacat (Ex: Consell General, Protecció de Dades, Financer, etc.)" },
                explicacio: { type: "STRING", description: "Breu síntesi del que ha succeït en aquesta categoria." }
              },
              required: ["nom", "explicacio"]
            },
            description: "Les àrees o sectors principals on s'han concentrat les notícies."
          },
          noticiesAmbImpacte: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                titol: { type: "STRING" },
                link: { type: "STRING", description: "L'enllaç URL de la notícia, copiat exactament de la llista original." },
                impacte: { type: "STRING", description: "Explicació breu de l'impacte o importància per al ciutadà o empresa." }
              },
              required: ["titol", "link", "impacte"]
            },
            description: "Selecció de les notícies principals explicades des de l'òptica de l'impacte."
          }
        },
        required: ["resumExecutiu", "puntsClau", "categoriesDestacades", "noticiesAmbImpacte"]
      }
      }
    });

    const summaryJson = JSON.parse(response.text);
    const summary = normalizeAiSummary(summaryJson, newsForPrompt, fallbackSummary);
    aiSummaryCache.set(requestedArea, { timestamp: Date.now(), data: summary });
    return summary;
  } catch (error) {
    console.error('AI summary unavailable; using deterministic legal brief:', error.message);
    const summary = buildDeterministicSummary(weeklyNews, newsForPrompt, error.message, requestedArea);
    aiSummaryCache.set(requestedArea, { timestamp: Date.now(), data: summary });
    return summary;
  }
}

// API Endpoint to get AI-generated weekly summary
app.get('/api/news/summary', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === 'true';
    const summary = await getAiSummary(forceRefresh, req.query.area);
    res.json(summary);
  } catch (error) {
    if (error.status !== 400) {
      console.error("Error generant el resum setmanal:", error);
    }
    let errorMsg = "S'ha produït un error al generar el resum setmanal amb Intel·ligència Artificial.";
    let status = error.status || 500;
    if (status === 400) errorMsg = error.message;
    if (error.status === 429 || (error.message && (error.message.includes('Quota') || error.message.includes('quota') || error.message.includes('429') || error.message.includes('RESOURCE_EXHAUSTED')))) {
      status = 429;
      errorMsg = "QUOTA_EXCEEDED";
    }
    res.status(status).json({ error: errorMsg });
  }
});

// Helper to convert YYYY-MM-DD to Catalan date string (e.g. "Dimarts, 14 de juliol del 2026")
function parseDateToCatalan(dateStr) {
  if (!dateStr) return '';
  const parts = dateStr.split('-');
  if (parts.length !== 3) return dateStr;
  const year = parts[0];
  const monthIndex = parseInt(parts[1], 10) - 1;
  const day = parseInt(parts[2], 10);
  
  const daysOfWeek = ['Diumenge', 'Dilluns', 'Dimarts', 'Dimecres', 'Dijous', 'Divendres', 'Dissabte'];
  const months = ['gener', 'febrer', 'març', 'abril', 'maig', 'juny', 'juliol', 'agost', 'setembre', 'octubre', 'novembre', 'desembre'];
  
  const dateObj = new Date(year, monthIndex, day);
  const dayOfWeek = daysOfWeek[dateObj.getDay()];
  const monthName = months[monthIndex];
  
  let prep = "de";
  if (monthName.startsWith('a') || monthName.startsWith('o')) {
    prep = "d'";
  }
  
  return `${dayOfWeek}, ${day} ${prep} ${monthName} del ${year}`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function safeExternalUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '#';
  } catch (error) {
    return '#';
  }
}

// Generate HTML Newsletter Template with responsive and inline styles
function generateNewsletterHtml(dateStr, editorialIntro, puntsClau, noticiesAmbImpacte, allNewsItems, editorialMode, practiceArea = 'all') {
  const dateFormatted = parseDateToCatalan(dateStr);
  const methodLabel = editorialMode === 'ai'
    ? 'Edició assistida per IA sobre fonts oficials'
    : 'Síntesi automàtica de fonts oficials';
  const areaLabel = practiceArea === 'all' ? 'Totes les àrees de pràctica' : practiceArea;
  
  const pointsHtml = puntsClau.map(pt => `
    <li style="margin-bottom: 8px; color: #334155; font-size: 15px; line-height: 1.5; font-family: 'Inter', sans-serif;">
      ${escapeHtml(pt)}
    </li>
  `).join('');

  const articlesHtml = noticiesAmbImpacte.map(ai => {
    const orig = allNewsItems.find(item => item.link === ai.link || item.title === ai.titol) || {};
    const sourceName = orig.source || "Actualitat";
    const category = orig.category || "General";
    const practiceArea = orig.practiceArea || "General i institucional";
    const documentType = orig.documentType || "Actualitat oficial";
    const articleLink = safeExternalUrl(ai.link);
    
    let badgeColor = "#64748b";
    if (sourceName.includes("Consell")) badgeColor = "#8b5cf6";
    else if (sourceName.includes("APDA")) badgeColor = "#06b6d4";
    else if (sourceName.includes("Govern")) badgeColor = "#3b82f6";
    else if (sourceName.includes("UE")) badgeColor = "#10b981";
    else if (sourceName.includes("AFA")) badgeColor = "#f59e0b";
    else if (sourceName.includes("BOPA")) badgeColor = "#ef4444";

    return `
      <div class="news-card" style="background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 20px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 10px;">
          <tr>
            <td>
              <span class="badge" style="background-color: ${badgeColor}; color: #ffffff; font-size: 11px; font-weight: bold; padding: 4px 10px; border-radius: 20px; text-transform: uppercase; font-family: 'Inter', sans-serif;">
                ${escapeHtml(sourceName)}
              </span>
              <span class="category" style="color: #64748b; font-size: 12px; margin-left: 10px; font-family: 'Inter', sans-serif;">
                • ${escapeHtml(documentType)} · ${escapeHtml(practiceArea)} · ${escapeHtml(orig.legalStage || 'Seguiment')}
              </span>
            </td>
          </tr>
        </table>
        <h3 style="margin-top: 0; margin-bottom: 10px; font-size: 18px; font-family: 'Outfit', 'Inter', sans-serif; font-weight: 700; line-height: 1.3;">
          <a href="${articleLink}" target="_blank" rel="noopener noreferrer" style="color: #0f172a; text-decoration: none;">
            ${escapeHtml(ai.titol)}
          </a>
        </h3>
        <p style="color: #475569; font-size: 14px; line-height: 1.5; margin-bottom: 12px; font-family: 'Inter', sans-serif;">
          ${escapeHtml(orig.snippet || "")}
        </p>
        ${orig.entryIntoForce ? `
        <div style="background-color: #eff6ff; border: 1px solid #bfdbfe; color: #1e3a8a; padding: 10px 12px; border-radius: 8px; margin-bottom: 12px; font-size: 13px; line-height: 1.45; font-family: 'Inter', sans-serif;">
          <strong>Entrada en vigor:</strong> ${escapeHtml(orig.entryIntoForce)}
        </div>` : ''}
        ${orig.operativeDeadlines?.length ? `
        <div style="background-color: #fffbeb; border: 1px solid #fde68a; color: #78350f; padding: 10px 12px; border-radius: 8px; margin-bottom: 12px; font-size: 13px; line-height: 1.45; font-family: 'Inter', sans-serif;">
          <strong>Possible termini — comprovar al text oficial:</strong>
          ${orig.operativeDeadlines.map(deadline => `<div style="margin-top: 5px;">${escapeHtml(deadline)}</div>`).join('')}
        </div>` : ''}
        ${orig.affectedProfiles ? `
        <div style="color: #475569; font-size: 13px; line-height: 1.45; margin: 0 0 12px 0; font-family: 'Inter', sans-serif;">
          <strong>Pot interessar a:</strong> ${escapeHtml(orig.affectedProfiles)}
        </div>` : ''}
        <div class="impact-section" style="background-color: #f8fafc; border-left: 3px solid #3b82f6; padding: 10px 15px; border-radius: 0 8px 8px 0; margin-top: 10px;">
          <p style="margin: 0; font-size: 13px; font-style: italic; color: #1e293b; font-family: 'Inter', sans-serif; font-weight: 500;">
            <strong>Per què convé revisar-ho:</strong> ${escapeHtml(ai.impacte)}
          </p>
        </div>
      </div>
    `;
  }).join('');

  return `<!DOCTYPE html>
<html lang="ca">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Andorra Legal Brief · Butlletí setmanal</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Outfit:wght@400;500;600;700;800&display=swap');
    body {
      margin: 0;
      padding: 0;
      background-color: #f8fafc;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    @media only screen and (max-width: 600px) {
      .container {
        width: 100% !important;
        padding: 10px !important;
      }
      .header-content {
        padding: 30px 20px !important;
      }
      .body-content {
        padding: 20px 15px !important;
      }
    }
  </style>
</head>
<body style="margin: 0; padding: 0; background-color: #f8fafc; font-family: 'Inter', sans-serif;">
  <center>
    <table width="100%" border="0" cellpadding="0" cellspacing="0" style="background-color: #f8fafc; padding: 30px 0;">
      <tr>
        <td align="center">
          <table class="container" width="600" border="0" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 20px rgba(15, 23, 42, 0.05); border: 1px solid #e2e8f0;">
            <tr>
              <td class="header-content" align="center" style="background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%); padding: 40px 30px; text-align: center; border-bottom: 4px solid #3b82f6;">
                <table border="0" cellpadding="0" cellspacing="0" align="center">
                  <tr>
                    <td align="center" style="background-color: rgba(59, 130, 246, 0.15); border-radius: 12px; padding: 12px; width: 44px; height: 44px; display: inline-block;">
                      <span style="font-size: 24px; color: #3b82f6; line-height: 44px;">⚖️</span>
                    </td>
                  </tr>
                </table>
                <h1 style="color: #ffffff; font-family: 'Outfit', sans-serif; font-size: 26px; font-weight: 800; margin: 15px 0 5px 0; letter-spacing: -0.02em;">ANDORRA LEGAL BRIEF</h1>
                <p style="color: #3b82f6; font-family: 'Outfit', sans-serif; font-size: 14px; font-weight: 600; margin: 0 0 10px 0; text-transform: uppercase; letter-spacing: 0.1em;">Novetats per a la pràctica jurídica</p>
                <p style="color: #94a3b8; font-size: 13px; margin: 0;">${dateFormatted}</p>
                <p style="color: #bfdbfe; font-size: 12px; font-weight: 600; margin: 8px 0 0 0;">Àrea: ${escapeHtml(areaLabel)}</p>
                <p style="display: inline-block; color: #cbd5e1; background-color: rgba(255,255,255,0.08); border-radius: 999px; padding: 5px 10px; font-size: 11px; margin: 12px 0 0 0;">${methodLabel}</p>
              </td>
            </tr>
            <tr>
              <td class="body-content" style="padding: 30px 40px; background-color: #ffffff;">
                <div style="background-color: #f1f5f9; border-left: 4px solid #3b82f6; padding: 20px; border-radius: 8px; margin-bottom: 30px;">
                  <h2 style="margin-top: 0; margin-bottom: 10px; font-family: 'Outfit', sans-serif; font-size: 18px; color: #0f172a; font-weight: 700;">Resum de la Setmana</h2>
                  <p style="margin: 0; color: #334155; font-size: 14px; line-height: 1.6; font-family: 'Inter', sans-serif;">
                    ${escapeHtml(editorialIntro)}
                  </p>
                </div>
                
                <h2 style="font-family: 'Outfit', sans-serif; font-size: 18px; color: #0f172a; font-weight: 700; border-bottom: 2px solid #f1f5f9; padding-bottom: 10px; margin-bottom: 15px;">Fets Destacats</h2>
                <ul style="margin: 0 0 30px 0; padding-left: 20px;">
                  ${pointsHtml}
                </ul>
                
                <h2 style="font-family: 'Outfit', sans-serif; font-size: 18px; color: #0f172a; font-weight: 700; border-bottom: 2px solid #f1f5f9; padding-bottom: 10px; margin-bottom: 20px;">Novetats jurídiques de la setmana</h2>
                <div>
                  ${articlesHtml}
                </div>
              </td>
            </tr>
            <tr>
              <td align="center" style="background-color: #f8fafc; padding: 30px 40px; border-top: 1px solid #e2e8f0; text-align: center;">
                <p style="color: #64748b; font-size: 12px; margin: 0 0 10px 0; line-height: 1.5; font-family: 'Inter', sans-serif;">
                  Síntesi elaborada a partir de fonts oficials d'Andorra. Contingut informatiu: cal consultar sempre el text oficial i no constitueix assessorament jurídic.
                </p>
                <p style="color: #94a3b8; font-size: 11px; margin: 0; font-family: 'Inter', sans-serif;">
                  © 2026 Andorra Legal Brief.
                </p>
                <div style="margin-top: 15px;">
                  <a href="https://rssand-production.up.railway.app" style="color: #3b82f6; text-decoration: none; font-size: 12px; font-weight: 600; font-family: 'Outfit', sans-serif;">
                    Obrir l'aplicació web ↗
                  </a>
                </div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </center>
</body>
</html>`;
}

// Generate Plain Text Fallback Version of the Newsletter
function generateNewsletterText(dateStr, editorialIntro, puntsClau, noticiesAmbImpacte, allNewsItems, editorialMode, practiceArea = 'all') {
  const dateFormatted = parseDateToCatalan(dateStr);
  const methodLabel = editorialMode === 'ai'
    ? 'Edició assistida per IA sobre fonts oficials'
    : 'Síntesi automàtica de fonts oficials';
  const pointsText = puntsClau.map(pt => `• ${pt}`).join('\n');
  const articlesText = noticiesAmbImpacte.map((ai, idx) => {
    const original = allNewsItems.find(item => item.link === ai.link || item.title === ai.titol) || {};
    return `${idx + 1}. ${ai.titol}
   Fase: ${original.legalStage || 'Seguiment'}
   Pot interessar a: ${original.affectedProfiles || 'Professionals de l’àrea'}
   ${original.operativeDeadlines?.length ? `Possible termini (comprovar al text oficial): ${original.operativeDeadlines.join(' | ')}\n   ` : ''}Enllaç: ${ai.link}
   Per què convé revisar-ho: ${ai.impacte}
`;
  }).join('\n');

  return `ANDORRA LEGAL BRIEF - Novetats per a la pràctica jurídica
Data: ${dateFormatted}
Mètode editorial: ${methodLabel}
Àrea: ${practiceArea === 'all' ? 'Totes les àrees de pràctica' : practiceArea}
==================================================

RESUM DE LA SETMANA:
${editorialIntro}

--------------------------------------------------
FETS DESTACATS:
${pointsText}

--------------------------------------------------
NOVETATS JURÍDIQUES DE LA SETMANA:
${articlesText}

==================================================
Síntesi de fonts oficials. Cal consultar sempre el text oficial; no constitueix assessorament jurídic.
Obrir l'aplicació web: https://rssand-production.up.railway.app
`;
}

// API Endpoint to get the AI-generated weekly legal newsletter
app.get('/api/news/newsletter', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === 'true';
    const summary = await getAiSummary(forceRefresh, req.query.area);
    const practiceArea = summary.practiceArea || 'all';

    let items = newsCache;
    if (!items || items.length === 0) {
      items = await fetchAllFeeds();
    }

    if (!items || items.length === 0) {
      return res.status(404).json({ error: "No s'han trobat notícies per al butlletí." });
    }

    const dates = [...new Set(items.map(item => item.date))].sort().reverse();
    const latestDate = dates.length > 0 ? dates[0] : new Date().toISOString().split('T')[0];

    // Filter news from the last 7 days for the newsletter's feed content
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const limitDateStr = sevenDaysAgo.toISOString().split('T')[0];
    const weeklyNews = items.filter(item =>
      item.date >= limitDateStr &&
      item.legalRelevance !== 'low' &&
      item.isLegislative !== false &&
      (practiceArea === 'all' || item.practiceArea === practiceArea)
    );

    const newsletterData = {
      editorialIntro: summary.resumExecutiu,
      puntsClau: summary.puntsClau,
      noticiesAmbImpacte: summary.noticiesAmbImpacte,
      editorialMode: summary.editorialMode,
      editorialNote: summary.editorialNote
    };

    const htmlContent = generateNewsletterHtml(
      latestDate,
      newsletterData.editorialIntro,
      newsletterData.puntsClau,
      newsletterData.noticiesAmbImpacte,
      weeklyNews,
      newsletterData.editorialMode,
      practiceArea
    );

    const textContent = generateNewsletterText(
      latestDate,
      newsletterData.editorialIntro,
      newsletterData.puntsClau,
      newsletterData.noticiesAmbImpacte,
      weeklyNews,
      newsletterData.editorialMode,
      practiceArea
    );

    res.json({
      timestamp: new Date().toISOString(),
      date: latestDate,
      itemsCount: weeklyNews.length,
      practiceArea,
      data: newsletterData,
      html: htmlContent,
      text: textContent
    });

  } catch (error) {
    if (error.status !== 400) {
      console.error("Error generant el butlletí jurídic setmanal:", error);
    }
    let errorMsg = "S'ha produït un error al generar el butlletí jurídic setmanal amb Intel·ligència Artificial.";
    let status = error.status || 500;
    if (status === 400) errorMsg = error.message;
    if (error.status === 429 || (error.message && (error.message.includes('Quota') || error.message.includes('quota') || error.message.includes('429') || error.message.includes('RESOURCE_EXHAUSTED')))) {
      status = 429;
      errorMsg = "QUOTA_EXCEEDED";
    }
    res.status(status).json({ error: errorMsg });
  }
});

// Start Express Server
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
}

module.exports = {
  app,
  buildLegalRss,
  getProfessionalReview,
  extractBopaDocumentSignals,
  normalizeSubscriptionRequest,
  getEmailSubscriptionConfig,
  generateNewsletterText
};
