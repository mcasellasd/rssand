const cheerio = require('cheerio');

const AGENDA_URL = 'https://www.consellgeneral.ad/ca/agenda';
const CACHE_MS = 60 * 60 * 1000;
const MONTHS = new Map([
  ['gener', 1], ['febrer', 2], ['marc', 3], ['març', 3], ['abril', 4], ['maig', 5],
  ['juny', 6], ['juliol', 7], ['agost', 8], ['setembre', 9], ['octubre', 10],
  ['novembre', 11], ['desembre', 12]
]);
const MONTH_SLUGS = new Map([
  ['jan', 1], ['feb', 2], ['mar', 3], ['abr', 4], ['mai', 5], ['jun', 6],
  ['jul', 7], ['ago', 8], ['set', 9], ['oct', 10], ['nov', 11], ['des', 12]
]);
const WEEKDAYS = new Map([
  ['dilluns', 1], ['dimarts', 2], ['dimecres', 3], ['dijous', 4],
  ['divendres', 5], ['dissabte', 6], ['diumenge', 7]
]);
const STOP_WORDS = new Set([
  'projecte', 'proposicio', 'llei', 'llei', 'qualificada', 'iniciativa', 'parlamentaria',
  'analisi', 'informe', 'ponent', 'ponencia', 'comissio', 'legislativa', 'relatiu',
  'relativa', 'del', 'dels', 'd', 'de', 'la', 'les', 'els', 'el', 'al', 'als',
  'per', 'una', 'un', 'i', 'a', 'en', 'si', 'escau'
]);
let cached = null;
let cachedAt = 0;
let inFlight = null;

function cleanText(value) {
  return String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}
function normalize(value) {
  return cleanText(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('ca').replace(/[^a-z0-9]+/g, ' ').trim();
}
function parseWeekStart(text) {
  const match = cleanText(text).match(/\b(\d{1,2})\s+de\s+([a-zç]+)\s+de\s+(\d{4})\s*[-–]\s*\d{1,2}\s+de\s+[a-zç]+\s+de\s+\d{4}\b/i);
  if (!match) return null;
  const month = MONTHS.get(normalize(match[2]));
  if (!month) return null;
  return new Date(Date.UTC(Number(match[3]), month - 1, Number(match[1])));
}
function dateFromSlug(href) {
  const iso = String(href || '').match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const slug = String(href || '').toLocaleLowerCase('ca').match(/(?:^|[-.])(\d{1,2})(jan|feb|mar|abr|mai|jun|jul|ago|set|oct|nov|des)(20\d{2})(?:$|[-.])/);
  if (!slug) return null;
  const month = MONTH_SLUGS.get(slug[2]);
  return month ? `${slug[3]}-${String(month).padStart(2, '0')}-${String(slug[1]).padStart(2, '0')}` : null;
}
function dayDate(dayNumber, weekday, weekStart) {
  if (!weekStart) return null;
  const offset = (weekday - (weekStart.getUTCDay() || 7) + 7) % 7;
  const date = new Date(weekStart);
  date.setUTCDate(date.getUTCDate() + offset);
  if (date.getUTCDate() !== dayNumber) return null;
  return date.toISOString().slice(0, 10);
}
function todayInAndorra() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Andorra' }).format(new Date());
}
function agendaHref(value) {
  try {
    const url = new URL(value, AGENDA_URL);
    return url.protocol === 'https:' && url.hostname === 'www.consellgeneral.ad' &&
      url.pathname.startsWith('/ca/agenda/') &&
      !/folder_agenda_view|\/ca\/agenda\/agenda(?:\/|$)/.test(url.pathname) ? url.href : null;
  } catch (_) { return null; }
}
function eventContainer($, anchor) {
  let node = $(anchor);
  for (let depth = 0; depth < 9; depth += 1) {
    node = node.parent();
    if (!node.length) break;
    const text = cleanText(node.text());
    if (text.length < 70 || text.length > 6000 || !/ordre del dia/i.test(text)) continue;
    const eventLinks = node.find('a[href]').toArray().map(link => agendaHref($(link).attr('href'))).filter(Boolean);
    if (eventLinks.length === 1) return node;
  }
  return null;
}
function extractAgendaItems($, node, text) {
  const items = node ? node.find('li').toArray().map(item => cleanText($(item).text())).filter(item => item.length > 12) : [];
  if (items.length) return [...new Set(items)].slice(0, 10);
  const match = text.match(/ordre del dia(?: d['’]aquesta sessió)?\s*:?\s*(.*?)(?=at[eè]s l['’]objecte|aquesta reuni[oó]|$)/i);
  if (!match) return [];
  return match[1].split(/(?=\b\d+\s*[.)])/).map(cleanText).map(item => item.replace(/^\d+\s*[.)]\s*/, '')).filter(item => item.length > 12).slice(0, 10);
}
function privacyStatus(text) {
  if (/no tindr[aà] car[aà]cter p[uú]blic|no ser[aà] p[uú]blica/i.test(text)) return false;
  if (/tindr[aà] car[aà]cter p[uú]blic|ser[aà] p[uú]blica/i.test(text)) return true;
  return null;
}
function parseAgenda(html) {
  const $ = cheerio.load(html);
  const pageText = cleanText($('body').text());
  const weekStart = parseWeekStart(pageText);
  const elements = $('body').find('*').toArray();
  const order = new Map(elements.map((element, index) => [element, index]));
  const dayHeadings = [];
  for (const element of elements) {
    const text = cleanText($(element).text());
    if (text.length > 60) continue;
    const match = normalize(text).match(/^(dilluns|dimarts|dimecres|dijous|divendres|dissabte|diumenge)\s*,?\s*(\d{1,2})$/);
    if (!match) continue;
    const date = dayDate(Number(match[2]), WEEKDAYS.get(match[1]), weekStart);
    if (date) dayHeadings.push({ index: order.get(element), date });
  }

  const meetings = [];
  const seen = new Set();
  $('a[href]').each((_, anchor) => {
    const url = agendaHref($(anchor).attr('href'));
    if (!url || seen.has(url)) return;
    const title = cleanText($(anchor).text());
    if (!title || title.length > 180) return;
    const card = eventContainer($, anchor);
    if (!card) return;
    const text = cleanText(card.text());
    const match = text.match(/\b([01]?\d|2[0-3]):([0-5]\d)\s*h?\b/i);
    const index = order.get(anchor) ?? 0;
    const priorDay = [...dayHeadings].reverse().find(item => item.index < index);
    const date = dateFromSlug(url) || priorDay?.date || null;
    if (!date || !match) return;
    const agendaItems = extractAgendaItems($, card, text);
    if (!agendaItems.length) return;
    seen.add(url);
    meetings.push({
      date,
      time: `${match[1].padStart(2, '0')}:${match[2]}`,
      title,
      agendaItems,
      isPublic: privacyStatus(text),
      url
    });
  });
  return meetings.filter(meeting => meeting.date >= todayInAndorra())
    .sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
}
function initiativeTokens(value) {
  return normalize(value).split(' ').filter(token => token.length > 2 && !STOP_WORDS.has(token));
}
function matchesInitiative(item, meeting) {
  const titleTokens = [...new Set(initiativeTokens(item.title))];
  if (!titleTokens.length) return false;
  const agendaText = normalize(meeting.agendaItems.join(' '));
  const matched = titleTokens.filter(token => agendaText.includes(token)).length;
  return matched >= Math.min(2, titleTokens.length) && matched / titleTokens.length >= 0.6;
}
async function fetchAgendaPage(url) {
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.hostname !== 'www.consellgeneral.ad' ||
      !target.pathname.startsWith('/ca/agenda/')) {
    throw new Error('S’ha bloquejat una adreça fora de l’agenda oficial.');
  }
  const response = await fetch(target, {
    headers: { 'User-Agent': 'ActualitatJuridicaAndorrana/1.0 (agenda parlamentària)', 'Accept-Language': 'ca' },
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok || new URL(response.url || target).hostname !== 'www.consellgeneral.ad') {
    throw new Error(`L’agenda del Consell General ha retornat HTTP ${response.status} o una adreça no vàlida.`);
  }
  return response.text();
}
function nextWeekUrl(html) {
  const $ = cheerio.load(html);
  const href = $('a[href*="folder_agenda_view"]').toArray()
    .map(anchor => $(anchor).attr('href'))
    .find(value => value && /[?&]fecha=\d{4}-\d{2}-\d{2}/.test(value));
  if (!href) return null;
  const url = new URL(href, AGENDA_URL);
  return url.protocol === 'https:' && url.hostname === 'www.consellgeneral.ad' &&
    url.pathname.startsWith('/ca/agenda/') ? url.href : null;
}
async function loadParliamentaryAgenda({ refresh = false } = {}) {
  if (!refresh && cached && Date.now() - cachedAt < CACHE_MS) return { ...cached, cached: true };
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const currentHtml = await fetchAgendaPage(AGENDA_URL);
    const followingWeek = nextWeekUrl(currentHtml);
    const currentMeetings = parseAgenda(currentHtml);
    const nextMeetings = followingWeek ? parseAgenda(await fetchAgendaPage(followingWeek)) : [];
    const meetings = [...new Map([...currentMeetings, ...nextMeetings].map(meeting => [meeting.url, meeting])).values()]
      .filter(meeting => meeting.date >= todayInAndorra())
      .sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
    cached = { meetings, updatedAt: new Date().toISOString(), sourceUrl: AGENDA_URL };
    cachedAt = Date.now();
    return { ...cached, cached: false };
  })().catch(error => {
    if (cached) return { ...cached, cached: true, warning: error.message };
    throw error;
  }).finally(() => { inFlight = null; });
  return inFlight;
}
function attachAgendaMeetings(initiatives, meetings) {
  return initiatives.map(item => ({
    ...item,
    agendaMeetings: meetings.filter(meeting => matchesInitiative(item, meeting))
  }));
}
module.exports = { loadParliamentaryAgenda, attachAgendaMeetings, parseAgenda, matchesInitiative };
