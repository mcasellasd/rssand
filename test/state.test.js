const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseArray,
  uniqueLinks,
  findNewLinks,
  normalizeSavedItems,
  toggleSavedItem
} = require('../public/state');

const itemA = {
  link: 'https://example.ad/a',
  title: 'Llei A',
  date: '2026-07-16',
  practiceArea: 'Penal i seguretat',
  legalStage: 'Publicat al BOPA',
  professionalAction: 'Revisar l’entrada en vigor.',
  affectedProfiles: 'Despatxos penalistes',
  operativeDeadlines: ['Cal presentar el recurs dins dels 10 dies següents.']
};
const itemB = {
  link: 'https://example.ad/b',
  title: 'Decret B',
  date: '2026-07-15',
  practiceArea: 'Laboral i immigració'
};

test('la primera visita no etiqueta tot el catàleg com a nou', () => {
  assert.deepEqual(findNewLinks([itemA, itemB], [], false), []);
});

test('les visites següents detecten només els enllaços desconeguts', () => {
  assert.deepEqual(findNewLinks([itemA, itemB], [itemA.link], true), [itemB.link]);
});

test('la llista de pendents desa i elimina una publicació', () => {
  const saved = toggleSavedItem([], itemA);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].link, itemA.link);
  assert.equal(saved[0].legalStage, 'Publicat al BOPA');
  assert.equal(saved[0].professionalAction, 'Revisar l’entrada en vigor.');
  assert.deepEqual(saved[0].operativeDeadlines, itemA.operativeDeadlines);
  assert.deepEqual(toggleSavedItem(saved, itemA), []);
});

test('l’estat local corrupte es recupera com una llista buida', () => {
  assert.deepEqual(parseArray('{invalid'), []);
  assert.deepEqual(normalizeSavedItems([null, {}, itemA, itemA]).map(item => item.link), [itemA.link]);
  assert.deepEqual(uniqueLinks([itemA, itemA, itemB]), [itemA.link, itemB.link]);
});
