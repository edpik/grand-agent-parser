import { ConversionError } from './errors.js';
const fail = message => { throw new ConversionError('gsdx_index', message); };
const decoder = new TextDecoder('windows-1251', { fatal: true });
const MAX_RECORDS = 500000, MAX_TOKENS = 2000000;

// Read only the observed SDB record-array and unencoded search indexes.
// DocRows' names/units and GSH article payloads are deliberately not guessed.
export function recordTable(bytes, expectedVersion = 1) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 12 || view.getUint32(0, true) !== 23) fail('Неизвестный заголовок таблицы записей GSDX.');
  const version = view.getInt32(4, true), count = view.getUint32(8, true);
  if (!count && version === -1 && bytes.length === 12) return [];
  if (version !== expectedVersion || count > MAX_RECORDS || 12 + count * 4 > bytes.length)
    fail('Неподдерживаемая версия или размер индекса GSDX.');
  const first = 12 + count * 4;
  if (!count) { if (bytes.length !== 12) fail('Лишние байты в пустом индексе GSDX.'); return []; }
  const result = []; let previous = first;
  for (let i = 0; i < count; i++) {
    const offset = view.getUint32(12 + i * 4, true);
    const end = i + 1 < count ? view.getUint32(16 + i * 4, true) : bytes.length;
    if (offset !== previous || end < offset || end > bytes.length) fail('Повреждены смещения записей индекса GSDX.');
    result.push({ offset, end, bytes: bytes.subarray(offset, end) }); previous = end;
  }
  return result;
}

function stringRecord(bytes, trailing = 0) {
  if (bytes.length < 4 + trailing) fail('Обрезана строка индекса GSDX.');
  const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
  if (4 + size + trailing !== bytes.length) fail('Неверная длина строки индекса GSDX.');
  return decoder.decode(bytes.subarray(4, 4 + size));
}

export function readGsdxIndex(bytes, blocks) {
  const byName = new Map(blocks.map(b => [b.name, b])), decoded = [];
  const read = name => {
    const b = byName.get(name);
    if (!b) fail(`В базе отсутствует связанная таблица ${name}.`);
    return bytes.subarray(b.offset, b.offset + b.length);
  };
  if (!byName.has('CodeIndex') || !byName.has('DocRows')) return { records: [], decoded, indexedDescriptions: 0 };
  const rowRefs = recordTable(read('DocRows')); // Validate boundaries, do not claim that row payloads are decoded.
  const entries = recordTable(read('CodeIndex')), records = new Map();
  const docRows = byName.get('DocRows');
  for (const entry of entries) {
    const code = stringRecord(entry.bytes, 4), data = new DataView(entry.bytes.buffer, entry.bytes.byteOffset, entry.bytes.byteLength);
    const row = data.getUint32(entry.bytes.length - 4, true);
    if (row >= rowRefs.length) fail('Индекс кода ссылается на отсутствующую запись DocRows.');
    if (!records.has(row)) records.set(row, { rowIndex: row, codes: [], searchText: '', tokenCount: 0, tokenGaps: 0,
      indexStatus: 'code_only', path: `DocRows:record:${row}`, rowOffset: docRows.offset + rowRefs[row].offset,
      rowBytes: rowRefs[row].end - rowRefs[row].offset, numericStatus: 'unsupported_binary_payload', approved: 'false' });
    records.get(row).codes.push(code);
  }
  decoded.push('CodeIndex');
  const searchBlocks = blocks.filter(b => /^Fts2\\Row\d+$/.test(b.name));
  let indexedDescriptions = 0, tokens = 0, characters = 0;
  if (searchBlocks.length && byName.has('FtsWords')) {
    const words = recordTable(read('FtsWords')).map(entry => stringRecord(entry.bytes));
    decoded.push('FtsWords');
    for (const block of searchBlocks) {
      const rowIndex = Number(block.name.slice('Fts2\\Row'.length)), target = records.get(rowIndex);
      // Every interpreted forward index must map unambiguously to an actual code row.
      if (!target) fail('Поисковый индекс ссылается на запись без кода.');
      const positions = new Map();
      for (const entry of recordTable(read(block.name))) {
        if (entry.bytes.length < 8 || entry.bytes.length % 4) fail('Повреждён список позиций поискового индекса.');
        const view = new DataView(entry.bytes.buffer, entry.bytes.byteOffset, entry.bytes.byteLength);
        const word = view.getUint32(0, true), count = view.getUint32(4, true);
        if (word >= words.length || count * 4 + 8 !== entry.bytes.length || (tokens += count) > MAX_TOKENS)
          fail('Повреждён или слишком велик поисковый индекс GSDX.');
        for (let i = 0; i < count; i++) {
          const position = view.getUint32(8 + i * 4, true);
          if (position >= MAX_TOKENS || positions.has(position)) fail('Неоднозначные позиции слов поискового индекса.');
          positions.set(position, words[word]);
        }
      }
      const ordered = [...positions].sort((a, b) => a[0] - b[0]);
      target.searchText = ordered.map(([, word]) => word).join(' ');
      if ((characters += target.searchText.length) > 50000000) fail('Суммарный поисковый текст GSDX слишком велик.');
      target.tokenCount = ordered.length;
      target.tokenGaps = ordered.length ? ordered.at(-1)[0] + 1 - ordered.length : 0;
      target.indexStatus = 'search_tokens'; target.searchBlock = block.name;
      decoded.push(block.name); indexedDescriptions++;
    }
  }
  return { records: [...records.values()].sort((a, b) => a.rowIndex - b.rowIndex).map(row => ({ ...row, code: row.codes.join(' | ') })),
    decoded, indexedDescriptions };
}
