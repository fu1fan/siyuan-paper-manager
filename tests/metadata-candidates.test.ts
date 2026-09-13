import { uniqueMetadataCandidates } from '../src/services/metadata-candidates';
import type { MetadataCandidate } from '../src/types/import';
const candidate = (): MetadataCandidate => ({ provider: 'citoid', confidence: 0.98, reason: 'test',
  canonical: { title: 'MuxServe', itemType: 'journalArticle', creators: [], tags: [], doi: '10.1234/test' } });
it('removes cloned recommendations and repeated lookup results, keeping the selected object', () => {
  const selected = candidate();
  expect(uniqueMetadataCandidates([selected, structuredClone(selected), candidate()])).toEqual([selected]);
  expect(uniqueMetadataCandidates([selected, candidate()])[0]).toBe(selected);
});
it('ignores property order and recognition bookkeeping when metadata is identical', () => {
  const first = candidate();
  const second = { ...candidate(), reason: 'another source', confidence: 0.8, canonical: Object.fromEntries(Object.entries(first.canonical).reverse()) } as MetadataCandidate;
  expect(uniqueMetadataCandidates([first, second])).toHaveLength(1);
});
it('preserves same-title candidates when DOI, authors or abstract differ', () => {
  const first = candidate();
  const others = ['doi', 'abstract'].map(key => ({ ...candidate(), canonical: { ...first.canonical, [key]: 'different' } }));
  expect(uniqueMetadataCandidates([first, ...others])).toHaveLength(3);
});
