const test = require('node:test');
const assert = require('node:assert/strict');
const { buildLegalRss } = require('../server');

const items = [
  {
    title: 'Llei & protecció <digital>',
    link: 'https://example.ad/document?id=1&lang=ca',
    date: '2026-07-16',
    category: 'Lleis',
    documentType: 'Llei',
    practiceArea: 'Protecció de dades i digital',
    source: 'BOPA',
    snippet: 'Text oficial',
    isLegislative: true,
    legalRelevance: 'high'
  },
  {
    title: 'Resolució laboral',
    link: 'https://example.ad/document/2',
    date: '2026-07-15',
    category: 'Resolucions',
    documentType: 'Resolució',
    practiceArea: 'Laboral i immigració',
    source: 'BOPA',
    snippet: 'Text oficial',
    isLegislative: true,
    legalRelevance: 'medium'
  },
  {
    title: 'Actualitat institucional',
    link: 'https://example.ad/document/3',
    date: '2026-07-14',
    category: 'Actualitat',
    documentType: 'Actualitat oficial',
    practiceArea: 'General i institucional',
    source: 'Govern',
    snippet: 'Nota informativa',
    isLegislative: false,
    legalRelevance: 'low'
  }
];

test('el feed general només inclou publicacions jurídicament rellevants', () => {
  const xml = buildLegalRss(items, Date.UTC(2026, 6, 16), {
    channelUrl: 'https://brief.example/feed.xml'
  });

  assert.equal((xml.match(/<item>/g) || []).length, 2);
  assert.match(xml, /Llei &amp; protecció &lt;digital&gt;/);
  assert.match(xml, /document\?id=1&amp;lang=ca/);
  assert.doesNotMatch(xml, /Actualitat institucional/);
});

test('el feed personalitzat aplica àrea i rellevància alta alhora', () => {
  const xml = buildLegalRss(items, Date.UTC(2026, 6, 16), {
    area: 'Protecció de dades i digital',
    relevance: 'high',
    channelUrl: 'https://brief.example/feed.xml?area=Protecci%C3%B3'
  });

  assert.equal((xml.match(/<item>/g) || []).length, 1);
  assert.match(xml, /Protecció de dades i digital · impacte jurídic alt/);
  assert.match(xml, /Llei &amp; protecció/);
  assert.doesNotMatch(xml, /Resolució laboral/);
});

test('un filtre sense coincidències genera un canal vàlid i buit', () => {
  const xml = buildLegalRss(items, Date.UTC(2026, 6, 16), {
    area: 'Penal i seguretat',
    relevance: 'high',
    channelUrl: 'https://brief.example/feed.xml'
  });

  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.equal((xml.match(/<item>/g) || []).length, 0);
});
