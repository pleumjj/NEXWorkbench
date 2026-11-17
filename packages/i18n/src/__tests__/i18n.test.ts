import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtDate, languageOf, setLanguage, translate } from '../index';
import { TH } from '../th';

test('i18n · English is the source: unchanged in English', () => {
  setLanguage('en');
  assert.equal(translate('Settings'), 'Settings');
  assert.equal(translate('Disk space is low'), 'Disk space is low');
});

test('i18n · Thai: exact phrases, patterns with values, composite messages, unknown text untouched', () => {
  setLanguage('th');
  assert.equal(translate('Settings'), 'ตั้งค่า');
  assert.equal(translate('  Settings '), '  ตั้งค่า ', 'surrounding whitespace is kept');
  assert.match(translate('Last 7 days'), /^7 วัน/, '{n} pattern keeps the value');
  assert.equal(translate('my-project-name'), 'my-project-name', 'unknown text stays as it is');
  assert.equal(translate('Overview · Settings'), 'ภาพรวม · ตั้งค่า', 'parts joined with · are translated separately');
  assert.equal(translate('8.4 GB'), '8.4 GB');
  setLanguage('en');
});

test('i18n · dictionary is consistent: every Thai value uses the placeholders of its key', () => {
  for (const [en, th] of Object.entries(TH)) {
    const want = (en.match(/\{[ns]\}/g) ?? []).length;
    const got = (th.match(/\{(\d+|n|s)\}/g) ?? []).length;
    assert.equal(got, want, `placeholders differ: ${en} → ${th}`);
  }
  assert.ok(Object.keys(TH).length > 1500);
});

test('i18n · weak patterns are ignored so user text is never rewritten', () => {
  setLanguage('th');
  assert.equal(translate('5 h'), '5 h', '"{n} h" has too little text to be a safe pattern');
  setLanguage('en');
});

test('i18n · OS locale → language; Gregorian years in Thai', () => {
  assert.equal(languageOf('th-TH'), 'th');
  assert.equal(languageOf('en-TH'), 'en');
  setLanguage('th');
  assert.match(fmtDate('2026-11-12T12:00:00Z', { year: 'numeric' }), /2026/);
  setLanguage('en');
});
