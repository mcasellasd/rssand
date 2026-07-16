const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildLegalRss,
  getProfessionalReview,
  normalizeSubscriptionRequest,
  generateNewsletterText
} = require('../server');

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
    affectedProfiles: 'Responsables del tractament',
    professionalAction: 'Revisar obligacions i terminis.',
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
  assert.match(xml, /Pot interessar a: Responsables del tractament/);
  assert.match(xml, /Revisió suggerida: Revisar obligacions i terminis/);
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

test('la pauta professional diferencia una iniciativa d’una norma publicada', () => {
  const project = getProfessionalReview({
    documentType: 'Projecte de llei',
    practiceArea: 'Mercantil i societari'
  });
  const law = getProfessionalReview({
    documentType: 'Llei',
    practiceArea: 'Fiscal i duaner',
    officialDocument: true
  });

  assert.equal(project.legalStage, 'En tramitació');
  assert.match(project.professionalAction, /no tractar el projecte com a dret vigent/i);
  assert.equal(law.legalStage, 'Publicat al BOPA');
  assert.match(law.professionalAction, /entrada en vigor/i);
  assert.match(law.affectedProfiles, /assessoria fiscal/i);
});

test('la subscripció valida consentiment, correu i preferències', () => {
  assert.deepEqual(normalizeSubscriptionRequest({
    email: ' Advocada@Despatx.ad ',
    consent: true,
    practiceArea: 'Laboral i immigració',
    relevance: 'high'
  }), {
    email: 'advocada@despatx.ad',
    practiceArea: 'Laboral i immigració',
    relevance: 'high',
    isBot: false
  });

  assert.throws(() => normalizeSubscriptionRequest({
    email: 'no-es-un-correu',
    consent: true
  }), /adreça electrònica vàlida/i);
  assert.throws(() => normalizeSubscriptionRequest({
    email: 'advocat@despatx.ad',
    consent: false
  }), /política de privacitat/i);
});

test('la newsletter en text pla conserva fase, afectats i pauta de revisió', () => {
  const text = generateNewsletterText(
    '2026-07-16',
    'Resum editorial.',
    ['Fet destacat'],
    [{
      titol: items[0].title,
      link: items[0].link,
      impacte: items[0].professionalAction
    }],
    [{ ...items[0], legalStage: 'Publicat al BOPA' }],
    'deterministic',
    items[0].practiceArea
  );

  assert.match(text, /Fase: Publicat al BOPA/);
  assert.match(text, /Pot interessar a: Responsables del tractament/);
  assert.match(text, /Per què convé revisar-ho: Revisar obligacions i terminis/);
});
