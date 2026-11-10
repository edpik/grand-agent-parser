import test from 'node:test';
import assert from 'node:assert/strict';
import { convert, rowsFor, makeCsv, ConversionError } from '../src/converter.js';
import { recordTable } from '../src/gsdx-index.js';
import { indexedFixture, table } from './gsdx-fixture.mjs';
const indexError = e => e instanceof ConversionError && e.code === 'gsdx_index';

test('GSDX code rows are separate from catalog documents; ordered tokens retain gaps and no invented price/name/unit', async () => {
  const r = await convert(indexedFixture(), 'materials.gsdx');
  assert.equal(r.catalog.length, 1); assert.equal(r.records.length, 2); assert.equal(r.indexedDescriptions, 2);
  assert.equal(r.records[0].code, 'TEST-001'); assert.equal(r.records[0].searchText, 'truck 10');
  assert.equal(r.records[0].tokenGaps, 1); assert.equal(r.records[1].searchText, 'tank');
  assert.ok(r.records[0].rowOffset > 20); assert.equal(r.records[0].rowBytes, Buffer.byteLength('UNDECODED_ROW_0'));
  assert.equal(r.blocks.find(b => b.block === 'DocRows').status, 'uninterpreted');
  assert.equal(r.blocks.find(b => b.block === 'CodeIndex').status, 'decoded');
  assert.equal(r.blocks.find(b => b.block === 'Fts2\\Row0').status, 'decoded');
  const { rows, columns } = rowsFor([r], 'records');
  assert.equal(rows.length, 2); assert.equal(rows[0].sourceHash, r.sha256);
  assert.match(makeCsv(rows, columns), /truck 10/);
  assert.ok(!columns.some(([key]) => ['name', 'unit', 'price', 'quantity'].includes(key)));
  assert.match(r.warnings.join(' '), /пунктуации/);
});

test('GSDX without a forward search index exports codes with explicit code_only status', async () => {
  const r = await convert(indexedFixture({ fts: false }), 'codes.gsdx');
  assert.equal(r.records.length, 2); assert.equal(r.indexedDescriptions, 0);
  assert.equal(r.records[0].searchText, ''); assert.equal(r.records[0].indexStatus, 'code_only');
});

test('invalid code/row and word references or conflicting token positions fail explicitly', async () => {
  for (const options of [{ missingWord: true }, { missingRow: true }, { conflictingPosition: true }])
    await assert.rejects(convert(indexedFixture(options), 'bad.gsdx'), indexError);
});

test('record arrays reject invalid offsets, unsupported version and excessive count', () => {
  const bytes = table([Buffer.from('x')]);
  const invalid = Buffer.from(bytes); invalid.writeUInt32LE(15, 12);
  assert.throws(() => recordTable(invalid), indexError);
  assert.throws(() => recordTable(table([], 2)), indexError);
  const excessive = Buffer.from(bytes); excessive.writeUInt32LE(500001, 8);
  assert.throws(() => recordTable(excessive), indexError);
  assert.deepEqual(recordTable(Buffer.from([23,0,0,0,255,255,255,255,0,0,0,0])), []);
});
