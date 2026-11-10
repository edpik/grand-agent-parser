import test from 'node:test';
import assert from 'node:assert/strict';
import { convert, rowsFor, makeCsv, LIMITS, ConversionError } from '../src/converter.js';
import { gsdxDirectory, inflateGsdx, gsdxPages, gsdxHtmlText } from '../src/gsdx.js';
import { fixture, container, packed, article, firstHtml } from './gsdx-fixture.mjs';
const gsdxError = e => e instanceof ConversionError && e.code === 'gsdx';

test('GSDX exports catalog, all pages, zones and outlines with provenance, never invented numeric rows', async () => {
  const r = await convert(fixture(), 'тест.gsdx');
  assert.equal(r.container, 'GSDX / SDB5'); assert.equal(r.catalog.length, 2); assert.equal(r.pages.length, 2);
  assert.equal(r.positions.length, 0); assert.equal(r.catalog[1].documentId, '0');
  assert.equal(r.catalog[0].folders, 'ТЕР'); assert.equal(r.catalog[0].code, 'ТЕР13');
  assert.equal(r.catalog[1].articleAvailable, 'false');
  assert.equal(r.pages[0].text, 'Техническая часть & условия\nСталь | 100 м2');
  assert.equal(r.pages[0].assets, 1); assert.equal(r.pages[1].page, 2);
  assert.equal(r.pages[0].trailerBytes, Buffer.byteLength('UNINTERPRETED_TRAILER'));
  assert.equal(r.pages[0].path, '1\\Article2:page:1');
  assert.equal(r.approvedForCalculation, false); assert.equal(r.numericExtraction, 'unsupported_binary_payload');
  assert.ok(r.warnings.some(w => w.includes('не декодируются')));
  assert.equal(r.blocks.find(b => b.block === '1\\Data').status, 'uninterpreted');
  assert.equal(r.blocks.filter(b => b.status === 'decoded').length, 4);
  assert.ok(r.fields.some(f => f.path.startsWith('Zones:') && f.value === 'Кемерово'));
  assert.ok(r.fields.some(f => f.path.startsWith('1\\ArticleContent:')));
  for (const mode of ['catalog', 'pages', 'blocks', 'fields']) {
    const { rows, columns } = rowsFor([r], mode);
    assert.ok(rows.length); assert.ok(rows.every(row => row.sourceHash === r.sha256 && row.file === 'тест.gsdx'));
    const csv = makeCsv(rows, columns);
    assert.ok(csv.includes(r.sha256));
  }
  assert.equal(rowsFor([r], 'positions').rows.length, 0);
});

test('GSDX detected by bytes, and .gsdx validates signature instead of silently parsing XML', async () => {
  assert.equal((await convert(fixture(), 'renamed.gsf')).catalog.length, 2);
  await assert.rejects(convert(Buffer.from('<Document/>'), 'bad.gsdx'), gsdxError);
  const bytes = fixture(); bytes[3] = 6;
  await assert.rejects(convert(bytes, 'future.gsdx'), gsdxError);
});

test('empty catalog Document with omitted ID=0 is preserved', async () => {
  const r = await convert(fixture('<Region><Document/></Region>'), 'emptydoc.gsdx');
  assert.equal(r.catalog.length, 1); assert.equal(r.catalog[0].documentId, '0');
});

test('ambiguous and nonnumeric GSDX document IDs fail explicitly', async () => {
  await assert.rejects(convert(fixture('<Region><Document/><Document ID="0"/></Region>'), 'duplicate.gsdx'), gsdxError);
  await assert.rejects(convert(fixture('<Region><Document ID="wrong"/></Region>'), 'wrong.gsdx'), gsdxError);
});

test('GSDX directory validates bounds, duplicate names, safe uint64 offsets and overlap', () => {
  assert.throws(() => gsdxDirectory(fixture().slice(0, 30)), gsdxError);
  let bytes = fixture(), view = new DataView(bytes.buffer), start = view.getUint32(12, true);
  view.setBigUint64(start, 2n ** 63n, true);
  assert.throws(() => gsdxDirectory(bytes), gsdxError);
  bytes = fixture(); view = new DataView(bytes.buffer); start = view.getUint32(12, true);
  view.setBigUint64(start + 12, view.getBigUint64(start, true), true);
  assert.throws(() => gsdxDirectory(bytes), gsdxError);
  bytes = container({ AA: Buffer.from('a'), BB: Buffer.from('b') });
  bytes[29] = 65; bytes[30] = 65;
  assert.throws(() => gsdxDirectory(bytes), gsdxError);
});

test('GSDX DEFLATE enforces declared size, EOF, trailing bytes and expansion limit', () => {
  const data = Buffer.from('example'.repeat(100)); const raw = packed(data);
  assert.deepEqual(Buffer.from(inflateGsdx(raw)), data);
  assert.throws(() => inflateGsdx(raw, 10), gsdxError);
  assert.throws(() => inflateGsdx(raw.subarray(0, -1)), gsdxError);
  assert.throws(() => inflateGsdx(Buffer.concat([raw, Buffer.from([0])])), gsdxError);
  const bad = Buffer.from(raw); bad.writeUInt32LE(1);
  assert.throws(() => inflateGsdx(bad), gsdxError);
});

test('HTML2 validates page and embedded asset boundaries', () => {
  const bytes = article([firstHtml], { assets: true });
  assert.equal(gsdxPages(bytes).pages.length, 1);
  const bad = Buffer.from(bytes); bad.writeBigUInt64LE(2n ** 63n, 47);
  assert.throws(() => gsdxPages(bad), gsdxError);
  const truncated = bytes.subarray(0, -1); truncated.writeUInt32LE(truncated.length - 5, 5);
  assert.throws(() => gsdxPages(truncated), gsdxError);
});

test('Windows-1251 HTML decoding and entities preserve Cyrillic while excluding head and scripts', () => {
  const bytes = Buffer.concat([Buffer.from('<html><body><p>'), Buffer.from([0xd2,0xe5,0xf1,0xf2]), Buffer.from('&nbsp;&lt;1&gt;</p></body></html>')]);
  assert.equal(gsdxHtmlText(bytes).text, 'Тест <1>');
});

test('GSDX limits and mixed inputs keep datasets distinct', async () => {
  const r = await convert(fixture(), 'base.gsdx');
  const x = await convert(Buffer.from('<Document A="1"/>'), 'estimate.xml');
  assert.equal(rowsFor([r, x], 'catalog').rows.length, 2);
  assert.equal(rowsFor([r, x], 'pages').rows.length, 2);
  assert.equal(rowsFor([r, x], 'fields').rows.length, r.fields.length + x.fields.length);
  await assert.rejects(convert(fixture(), 'limit.gsdx', { ...LIMITS, xml: 10 }), gsdxError);
  await assert.rejects(convert(fixture(), 'limit.gsdx', { ...LIMITS, file: 10 }), e => e.code === 'file_limit');
});
