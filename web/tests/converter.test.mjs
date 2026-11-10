import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { zipSync, strToU8 } from 'fflate';
import { convert, parseXml, extractXml, decodeXml, rowsFor, makeCsv, filterRows, csvCell,
  literal, LIMITS, zipDirectory, crc32, ConversionError } from '../src/converter.js';

const document = (inside, attrs = '') => `<Document ${attrs}><Chapters><Chapter SysID="C" Caption="Ремонт">${inside}</Chapter></Chapters></Document>`;
const pos = '<Position SysID="P" Code="ТЕР01-01" Caption="Очистка" Units="100 м2" Quantity="250/100" PriceLevel="2001"><Quantity Result="2.500000" Fx="250/100"/><PriceBase PZ="123.4500" MT="0.00"/></Position>';
const code = expected => error => error instanceof ConversionError && error.code === expected;

test('real repository GSFX fixture: preserve values, units and repeated codes', async () => {
  const input = new Uint8Array(await readFile(new URL('../../examples/synthetic_estimate.gsfx', import.meta.url)));
  const result = await convert(input, 'пример.gsfx');
  assert.equal(result.positions.length, 2);
  assert.equal(result.positions[0].quantity, '2.500000');
  assert.equal(result.positions[0].unit, '100 м2');
  assert.equal(result.positions[1].quantity, '');
  assert.equal(result.positions[1].formula, 'unknown_formula');
  assert.equal(result.sha256.length, 64);
  assert.equal(result.formulaEvaluated, false);
  const csv = makeCsv(...[rowsFor([result])].map(x => x.rows).concat([rowsFor([result]).columns]));
  assert.ok(csv.startsWith('\ufeffФайл;'));
  assert.ok(csv.includes('2.500000'));
  assert.equal(result.positions[0].code, result.positions[1].code);
});

test('exact chapter position path; defect references are not estimate rows', () => {
  const xml = document(pos).replace('</Document>', '<DefectsList><Defect><Position Code="REFERENCE"/></Defect></DefectsList></Document>');
  const result = parseXml(xml);
  assert.equal(result.positions.length, 1);
  assert.equal(result.positions[0].code, 'ТЕР01-01');
  assert.equal(result.positions[0].basePZ, '123.4500');
  assert.equal(result.positions[0].raw['PriceBase[1].@MT'], '0.00');
  assert.ok(result.fields.some(f => f.value === 'REFERENCE'));
});

test('namespaced XML and nested resource quantities do not change position quantity', () => {
  const xml = '<n:Document xmlns:n="urn:test"><n:Chapters><n:Chapter><n:Position Code="A" Quantity="1"><n:Quantity Result="1.000"/><n:Resources><n:Resource><n:Quantity Result="99"/></n:Resource></n:Resources></n:Position></n:Chapter></n:Chapters></n:Document>';
  const result = parseXml(xml);
  assert.equal(result.positions[0].quantity, '1.000');
  assert.equal(result.positions[0].raw['n:Resources[1].n:Resource[1].n:Quantity[1].@Result'], '99');
});

test('an XML or ZIP file with .gsf extension is detected by bytes', async () => {
  const raw = await convert(strToU8(document(pos)), 'legacy.gsf');
  const zipped = await convert(zipSync({ 'Data.xml': strToU8(document(pos)) }), 'renamed.gsf');
  assert.equal(raw.positions[0].quantity, zipped.positions[0].quantity);
});

test('binary GSF gives an actionable error instead of a successful empty CSV', async () => {
  await assert.rejects(convert(new Uint8Array([71,83,72,3,99,0]), 'old.gsf'), code('legacy_gsf'));
});

test('GSDX is not mistaken for an estimate', () => {
  assert.throws(() => extractXml(new Uint8Array([83,68,66,5])), code('normative_base'));
});

test('protected Data.xml.crypt is not decoded or replaced with invented rows', async () => {
  const input = zipSync({ 'Data.xml.crypt': new Uint8Array([1,2,3]) });
  await assert.rejects(convert(input, 'protected.gsfx'), code('protected'));
});

test('unsafe archive paths and ambiguous Data.xml members are rejected', () => {
  assert.throws(() => extractXml(zipSync({ '../Data.xml': strToU8(document(pos)) })), code('unsafe_zip'));
  assert.throws(() => extractXml(zipSync({ 'a/Data.xml': strToU8(document(pos)), 'b/Data.xml': strToU8(document(pos)) })), code('ambiguous_xml'));
});

test('only the XML member is inflated, not unrelated large attachments', () => {
  const input = zipSync({ 'Data.xml': strToU8('<Document A="1"/>'), 'huge.bin': new Uint8Array(1024*1024) });
  assert.equal(extractXml(input, { ...LIMITS, xml: 512 }).bytes.length, 17);
});

test('XML decompression size limit is checked before unpacking', () => {
  const input = zipSync({ 'Data.xml': strToU8(document(pos)) });
  assert.throws(() => extractXml(input, { ...LIMITS, xml: 10 }), code('xml_limit'));
});

test('CRC detects a changed central-directory checksum', () => {
  const input = zipSync({ 'Data.xml': strToU8(document(pos)) });
  for (let i = 0; i < input.length - 4; i++) if (new DataView(input.buffer).getUint32(i,true) === 0x02014b50) {
    input[i+16] ^= 1; break;
  }
  assert.throws(() => extractXml(input), code('checksum'));
});

test('encrypted ZIP flags are rejected explicitly', () => {
  const input = zipSync({ 'Data.xml': strToU8(document(pos)) });
  for (let i = 0; i < input.length - 4; i++) if (new DataView(input.buffer).getUint32(i,true) === 0x02014b50) {
    input[i+8] |= 1; break;
  }
  assert.throws(() => extractXml(input), code('protected'));
});

test('DTD, malformed XML and excessive nesting fail clearly', () => {
  assert.throws(() => decodeXml(strToU8('<!DOCTYPE a [<!ENTITY x "x">]><a/>')), code('dtd'));
  assert.throws(() => parseXml('<Document><a></Document>'), code('invalid_xml'));
  assert.throws(() => parseXml('<a><b><c/></b></a>', { ...LIMITS, depth: 2 }), code('xml_complexity'));
});

test('UTF-16 and Windows-1251 encoding preserve Cyrillic', () => {
  const text = '<?xml version="1.0" encoding="utf-16"?><Document Caption="Смета"/>';
  const raw = new Uint8Array(Buffer.from('\ufeff' + text, 'utf16le'));
  assert.equal(parseXml(decodeXml(raw).text).fields[0].value, 'Смета');
  const header = strToU8('<?xml version="1.0" encoding="windows-1251"?><Document Caption="');
  const cp = new Uint8Array([...header, 0xd1,0xec,0xe5,0xf2,0xe0,...strToU8('"/>')]);
  assert.equal(parseXml(decodeXml(cp).text).fields[0].value, 'Смета');
});

test('UTF-32 is decoded with code-point validation', () => {
  const text = '<Document Caption="Смета"/>';
  const bytes = new Uint8Array((text.length + 1)*4), view = new DataView(bytes.buffer);
  view.setUint32(0, 0xfeff, true);
  [...text].forEach((ch,i) => view.setUint32((i+1)*4,ch.codePointAt(0),true));
  assert.equal(parseXml(decodeXml(bytes).text).fields[0].value,'Смета');
  view.setUint32(4,0x110000,true);
  assert.throws(() => decodeXml(bytes),code('encoding'));
});

test('missing cached quantities stay empty; formula is kept without evaluation', () => {
  const result = parseXml(document('<Position Code="X" Quantity="2*3"><Quantity Fx="2*3"/></Position><Position Code="Z" Quantity="0"/>'));
  assert.equal(result.positions[0].quantity, '');
  assert.equal(result.positions[0].formula, '2*3');
  assert.equal(result.positions[1].quantity, '0');
  assert.equal(literal('001.2300'),'001.2300');
});

test('other document types offer XML fields but are not misidentified as local estimates', () => {
  const result = parseXml(document(pos, 'DocumentType="{00000000-0000-0000-0000-000000000000}"'));
  assert.equal(result.positions.length, 0);
  assert.ok(result.fields.length > 0);
  assert.ok(result.warnings.length > 0);
});

test('CSV quoting, Unicode BOM, newlines and empty cells are correct', () => {
  const columns = [['a','Код'],['b','Описание']];
  const csv = makeCsv([{a:'01-01',b:'Сталь; "лист"\n2 мм'},{a:'0',b:null}], columns);
  assert.equal(csv,'\ufeffКод;Описание\r\n01-01;"Сталь; ""лист""\n2 мм"\r\n0;\r\n');
  assert.equal(csvCell('a,b',','),'"a,b"');
  assert.equal(csvCell('a\tb','\t'),'"a\tb"');
});

test('spreadsheet formulas in text are guarded; exact numeric literals are preserved', () => {
  assert.equal(csvCell('=1+2',';'),"'=1+2");
  assert.equal(csvCell(' @SUM(1)',';'),"' @SUM(1)");
  assert.equal(csvCell('-1.2300',';'),'-1.2300');
  assert.equal(csvCell('=1+2',';',false),'=1+2');
});

test('filter and raw XML columns use the same rows as the download', () => {
  const result = { ...parseXml(document(pos)), name:'пример.gsfx' };
  const {rows,columns} = rowsFor([result], 'positions', true);
  assert.ok(columns.some(([key]) => key === 'xml:PriceBase[1].@PZ'));
  assert.equal(filterRows(rows,'очистка',columns).length,1);
  assert.equal(filterRows(rows,'нет',columns).length,0);
  assert.ok(!rowsFor([result],'positions',false).columns.some(([k])=>k.startsWith('xml:')));
});

test('CSV cross-product limit prevents giant sparse exports', () => {
  assert.throws(() => makeCsv(Array(1000).fill({}), Array(6000).fill(['a','A'])), code('csv_width'));
});

test('standard CRC-32 reference vector', () => assert.equal(crc32(strToU8('123456789')),0xcbf43926));
