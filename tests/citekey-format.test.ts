import { generateCitekey, validateCitekeyFormat, uniqueCitekey } from '../src/core/naming';
import { normalizeSettings } from '../src/types/settings';
import { paperDataFromCandidate } from '../src/core/normalize';
import { paper } from './fixtures';
import { SOURCE } from '../src/constants';

const canonical = { ...paper().canonical, title: 'FlashAccel: Efficient Inference', date: '2026-09-11', creators: [{ family: 'Wang', given: 'A', creatorType: 'author' }] };
it('uses the new default for old settings and supports custom literals and order', () => {
  expect(normalizeSettings({}).citekeyFormat).toBe('{title}{year}{author}');
  expect(normalizeSettings({ citekeyFormat: '  ' }).citekeyFormat).toBe('{title}{year}{author}');
  expect(generateCitekey(canonical)).toBe('flashaccel2026wang');
  expect(generateCitekey(canonical, 'ref_{author}_{year}_{title}')).toBe('ref_wang_2026_flashaccel');
});
it('passes the configured format into imported paper data', () => {
  const result = paperDataFromCandidate({ id: 'test', source: SOURCE.pdf, canonical, raw: {}, attachments: [] }, '{author}-{year}-{title}');
  expect(result.citekey).toBe('wang-2026-flashaccel');
  expect(uniqueCitekey(result.citekey, [result.citekey.toUpperCase()])).toBe('wang-2026-flashaccela');
});
it('handles missing metadata and rejects invalid formats', () => {
  expect(generateCitekey({ ...canonical, title: '', date: undefined, creators: [] })).toBe('paperndanon');
  for (const format of ['', '{typo}', '{title', '{title}/x', '-{year}', 'constant', '{title}' + 'a'.repeat(120)]) {
    expect(() => validateCitekeyFormat(format)).toThrow();
  }
});
