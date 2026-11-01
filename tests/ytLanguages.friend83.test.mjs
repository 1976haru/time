import test from 'node:test';
import assert from 'node:assert/strict';
import { FALLBACK_LANGUAGE_CATALOG, getLanguageCatalog, maxLanguagesPerRequest, planLocalizations } from '../lib/ytLanguages.js';

test('friend release fallback has exactly 83 unique language codes', () => {
  assert.equal(FALLBACK_LANGUAGE_CATALOG.length, 83);
  assert.equal(new Set(FALLBACK_LANGUAGE_CATALOG.map(x => x.code.toLowerCase())).size, 83);
  assert.ok(FALLBACK_LANGUAGE_CATALOG.some(x => x.code === 'ko'));
  assert.ok(FALLBACK_LANGUAGE_CATALOG.some(x => x.code === 'ja'));
});
test('offline friend release still has 83 catalog choices and 82 targets for Japanese source', async () => {
  const { languages, source } = await getLanguageCatalog([]);
  assert.equal(source, 'fallback');
  assert.equal(languages.length, 83);
  const jaTargets = languages.filter(x => x.code !== 'ja');
  assert.equal(jaTargets.length, 82);
  assert.ok(jaTargets.some(x => x.code === 'ko'));
  assert.ok(languages.filter(x => x.code !== 'ko').some(x => x.code === 'ja'));
});
test('server accepts catalog-sized 83-language requests', async () => {
  await getLanguageCatalog([]);
  assert.ok(maxLanguagesPerRequest() >= 83);
});
test('explicit target code is preserved and source language is skipped', () => {
  const results = [
    { language: '한국어', languageCode: 'ko', translatedTitle: '제목', translatedDescription: '설명' },
    { language: '일본어', languageCode: 'ja', translatedTitle: 'タイトル', translatedDescription: '' },
  ];
  const result = planLocalizations(results, FALLBACK_LANGUAGE_CATALOG, { defaultLanguage: 'ja' });
  assert.deepEqual(result.planned.map(x => x.code), ['ko']);
  assert.deepEqual(result.skipped.map(x => x.code), ['ja']);
});
