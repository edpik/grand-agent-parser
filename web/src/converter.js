import { unzipSync } from 'fflate';
import { SaxesParser } from 'saxes';
import { ConversionError } from './errors.js';
import { convertGsdx } from './gsdx.js';
export { ConversionError } from './errors.js';

export const LIMITS = Object.freeze({ file: 256 * 1024 * 1024, total: 512 * 1024 * 1024, xml: 64 * 1024 * 1024,
  entries: 10000, nodes: 500000, fields: 400000, positions: 100000, depth: 128 });
const LS_TYPE = '2B0470FD-477C-4359-9F34-EEBE36B7D340';

const fail = (code, message) => { throw new ConversionError(code, message); };
const u16 = (d, p) => d.getUint16(p, true);
const u32 = (d, p) => d.getUint32(p, true);

export function zipDirectory(bytes, limits = LIMITS) {
  if (bytes.length < 22) fail('bad_zip', 'Архив повреждён: не найден каталог файлов.');
  const d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 65557); p--) {
    if (u32(d, p) === 0x06054b50 && p + 22 + u16(d, p + 20) === bytes.length) { end = p; break; }
  }
  if (end < 0) fail('bad_zip', 'Не удалось прочитать каталог ZIP. Попробуйте заново экспортировать GSFX.');
  const count = u16(d, end + 10), start = u32(d, end + 16), size = u32(d, end + 12);
  if (u16(d, end + 4) || u16(d, end + 6) || count !== u16(d, end + 8))
    fail('multipart_zip', 'Многотомные архивы не поддерживаются.');
  if (count === 65535 || start === 0xffffffff || size === 0xffffffff)
    fail('zip64', 'Этот ZIP64 слишком велик для браузерного конвертера.');
  if (count > limits.entries || start + size > end) fail('bad_zip', 'Некорректный или слишком большой каталог ZIP.');
  const entries = [], names = new Set();
  let p = start;
  for (let i = 0; i < count; i++) {
    if (p + 46 > start + size || u32(d, p) !== 0x02014b50) fail('bad_zip', 'Повреждена запись каталога ZIP.');
    const flags = u16(d, p + 8), method = u16(d, p + 10), compressed = u32(d, p + 20), original = u32(d, p + 24);
    const nameLength = u16(d, p + 28), extra = u16(d, p + 30), comment = u16(d, p + 32);
    const next = p + 46 + nameLength + extra + comment;
    if (next > start + size) fail('bad_zip', 'Повреждена длина имени в архиве.');
    const rawName = bytes.subarray(p + 46, p + 46 + nameLength);
    // Match fflate's non-UTF8 name representation for selecting the same member.
    const name = flags & 2048 ? new TextDecoder().decode(rawName) : Array.from(rawName, b => String.fromCharCode(b)).join('');
    const normalized = name.replaceAll('\\', '/');
    if (normalized.startsWith('/') || /^[a-z]:/i.test(normalized) || normalized.split('/').includes('..') || name.includes('\0'))
      fail('unsafe_zip', 'Архив содержит некорректный путь файла.');
    if (names.has(name)) fail('duplicate_zip', 'В архиве есть повторяющиеся имена файлов.');
    names.add(name);
    if (flags & 1) fail('protected', 'Архив защищён паролем. Экспортируйте обычный XML из ГРАНД-Сметы.');
    entries.push({ name, normalized, method, compressed, original, crc: u32(d, p + 16), offset: u32(d, p + 42) });
    p = next;
  }
  if (p !== start + size) fail('bad_zip', 'Каталог ZIP имеет неожиданную структуру.');
  return entries;
}

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) crc = CRC_TABLE[(crc ^ b) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function extractXml(bytes, limits = LIMITS) {
  if (bytes.length > limits.file) fail('file_limit', 'Файл больше 256 МиБ. Разделите документ или загрузите XML-экспорт меньшего размера.');
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    const entries = zipDirectory(bytes, limits);
    const plain = entries.filter(e => e.normalized.split('/').at(-1).toLowerCase() === 'data.xml');
    if (plain.length > 1) fail('ambiguous_xml', 'В архиве несколько Data.xml. Не удалось однозначно выбрать документ.');
    if (!plain.length) {
      if (entries.some(e => e.name.toLowerCase().endsWith('.crypt')))
        fail('protected', 'Внутри находится защищённый Data.xml.crypt. Экспортируйте документ в обычный XML в ГРАНД-Смете или Repair и загрузите полученный файл.');
      fail('no_xml', 'В архиве нет Data.xml. Загрузите сметный GSFX или XML-экспорт документа.');
    }
    const entry = plain[0];
    if (entry.original > limits.xml) fail('xml_limit', 'Распакованный XML больше 64 МБ. Разделите исходную смету.');
    if (![0, 8].includes(entry.method)) fail('zip_method', 'Этот способ сжатия ZIP пока не поддерживается.');
    let value;
    try { value = unzipSync(bytes, { filter: e => e.name === entry.name })[entry.name]; }
    catch { fail('bad_zip', 'Не удалось распаковать Data.xml. Возможно, архив повреждён.'); }
    if (!value || value.length !== entry.original || crc32(value) !== entry.crc)
      fail('checksum', 'Контрольная сумма Data.xml не совпадает. Попробуйте повторить экспорт.');
    return { bytes: value, kind: 'GSFX / ZIP', member: entry.name };
  }
  if (bytes[0] === 0x53 && bytes[1] === 0x44 && bytes[2] === 0x42)
    fail('normative_base', 'Это нормативная база GSDX, а не сметный документ. Этот интерфейс преобразует сметы GSFX и их XML-экспорты.');
  return { bytes, kind: 'XML', member: null };
}

function decodeUtf32(bytes, little) {
  if (bytes.length % 4) fail('encoding', 'Повреждена кодировка UTF-32.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), parts = [], codes = [];
  for (let i = 4; i < bytes.length; i += 4) {
    const cp = view.getUint32(i, little);
    if (cp > 0x10ffff || cp >= 0xd800 && cp <= 0xdfff) fail('encoding', 'Некорректный символ UTF-32.');
    codes.push(cp);
    if (codes.length === 8192) { parts.push(String.fromCodePoint(...codes)); codes.length = 0; }
  }
  if (codes.length) parts.push(String.fromCodePoint(...codes));
  return parts.join('');
}

export function decodeXml(bytes) {
  let encoding = 'utf-8', text;
  if (bytes[0] === 0xff && bytes[1] === 0xfe && bytes[2] === 0 && bytes[3] === 0) {
    encoding = 'utf-32le'; text = decodeUtf32(bytes, true);
  } else if (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 0xfe && bytes[3] === 0xff) {
    encoding = 'utf-32be'; text = decodeUtf32(bytes, false);
  } else {
    if (bytes[0] === 0xff && bytes[1] === 0xfe || bytes[0] === 0x3c && bytes[1] === 0) encoding = 'utf-16le';
    else if (bytes[0] === 0xfe && bytes[1] === 0xff || bytes[0] === 0 && bytes[1] === 0x3c) encoding = 'utf-16be';
    else {
      const header = new TextDecoder('windows-1251').decode(bytes.subarray(0, 512));
      encoding = /<\?xml[^>]*encoding\s*=\s*["']([^"']+)["']/i.exec(header)?.[1] || 'utf-8';
    }
    try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes); }
    catch { fail('encoding', 'Кодировка файла не распознана. Экспортируйте документ в XML UTF-8.'); }
  }
  if (!/^\s*</.test(text)) fail('legacy_gsf', 'Этот GSF содержит двоичные данные. Сначала преобразуйте его в XML через ГРАНД-Смету или утилиту Repair, затем загрузите XML сюда.');
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(text)) fail('dtd', 'XML содержит DTD или объявления сущностей. Такой документ не поддерживается.');
  return { text, encoding };
}

export function literal(value) {
  return typeof value === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim()) ? value.trim() : '';
}

export function parseXml(text, limits = LIMITS) {
  const parser = new SaxesParser({ xmlns: true });
  const stack = [], positions = [], fields = [], warnings = [], elements = [];
  let root = null, nodes = 0, captured = null;
  const addField = row => { if (fields.length >= limits.fields) fail('field_limit', 'В документе больше 400 000 XML-полей. Разделите его на несколько файлов.'); fields.push(row); };
  parser.on('doctype', () => fail('dtd', 'DTD и объявления сущностей не поддерживаются.'));
  parser.on('error', () => fail('invalid_xml', 'XML повреждён или содержит недопустимые символы. Проверьте исходный файл.'));
  parser.on('opentag', node => {
    if (++nodes > limits.nodes || stack.length >= limits.depth) fail('xml_complexity', 'Слишком сложная структура XML. Разделите исходный документ.');
    const parent = stack.at(-1), ordinal = parent ? (parent.counts[node.name] = (parent.counts[node.name] || 0) + 1) : 1;
    const path = (parent?.path || '') + `/${node.name}[${ordinal}]`;
    const attrs = Object.fromEntries(Object.values(node.attributes).map(a => [a.name, a.value]));
    if (node.local === 'Document') elements.push({ local: node.local, path });
    if (!root) root = { name: node.local, attributes: attrs };
    const entry = { name: node.name, local: node.local, path, attrs, counts: Object.create(null), text: '', ordinal };
    const isPosition = node.local === 'Position' && stack.length === 3 &&
      stack[0].local === 'Document' && stack[1].local === 'Chapters' && stack[2].local === 'Chapter';
    const type = root.attributes.DocumentType?.replace(/[{}]/g, '').toUpperCase();
    if (isPosition && (!type || type === LS_TYPE)) {
      if (positions.length >= limits.positions) fail('position_limit', 'В документе больше 100 000 позиций. Разделите смету.');
      captured = { attrs, chapter: stack[2].attrs, depth: stack.length, raw: Object.create(null), quantity: null, base: {}, current: {}, path };
    }
    stack.push(entry);
    for (const [name, value] of Object.entries(attrs)) {
      addField({ path, kind: 'Атрибут', key: name, value });
      if (captured) {
        const relative = stack.slice(captured.depth + 1).map(n => `${n.name}[${n.ordinal}]`).join('.');
        captured.raw[(relative ? relative + '.' : '') + '@' + name] = value;
      }
    }
    if (captured && stack.length === captured.depth + 2) {
      if (node.local === 'Quantity' && !captured.quantity) captured.quantity = attrs;
      if (node.local === 'PriceBase') captured.base = attrs;
      if (node.local === 'PriceCurr') captured.current = attrs;
    }
  });
  parser.on('text', text => { if (stack.length) stack.at(-1).text += text; });
  parser.on('cdata', text => { if (stack.length) stack.at(-1).text += text; });
  parser.on('closetag', () => {
    const node = stack.at(-1);
    if (node.text.trim()) {
      addField({ path: node.path, kind: 'Текст', key: '#text', value: node.text });
      if (captured) {
        const relative = stack.slice(captured.depth + 1).map(n => `${n.name}[${n.ordinal}]`).join('.');
        captured.raw[(relative ? relative + '.' : '') + '#text'] = node.text;
      }
    }
    if (captured && captured.depth === stack.length - 1) {
      const c = captured, a = c.attrs;
      positions.push({ number: a.Number || '', code: a.Code || '', name: a.Caption || '', unit: a.Units || '',
        quantity: literal(c.quantity ? c.quantity.Result : a.Quantity), formula: c.quantity?.Fx ?? a.Quantity ?? '',
        priceLevel: a.PriceLevel || '', systemId: a.SysID || '', chapter: c.chapter.Caption || '',
        basePZ: c.base.PZ || '', baseOZ: c.base.OZ || '', baseEM: c.base.EM || '', baseZM: c.base.ZM || '',
        baseMT: c.base.MT || '', currentPZ: c.current.PZ || '', raw: c.raw, path: c.path });
      captured = null;
    }
    stack.pop();
  });
  try { parser.write(text).close(); }
  catch (error) { if (error instanceof ConversionError) throw error; fail('invalid_xml', 'Не удалось прочитать структуру XML.'); }
  if (!root) fail('empty_xml', 'В файле нет XML-документа.');
  if (!positions.length) warnings.push('Позиции локальной сметы не найдены. Можно выгрузить доступные данные в режиме «Все XML-поля».');
  const unresolved = positions.filter(p => !p.quantity && p.formula).length;
  if (unresolved) warnings.push(`У ${unresolved} поз. нет сохранённого числового объёма. Формулы сохранены отдельно и не вычислялись.`);
  return { positions, fields, warnings, root: root.name, documentType: root.attributes.DocumentType || '', nodes, elements };
}

export async function convert(bytes, name, limits = LIMITS) {
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (input.length > limits.file) fail('file_limit', 'Файл больше 256 МиБ.');
  let result;
  if (input[0] === 83 && input[1] === 68 && input[2] === 66 || /\.gsdx$/i.test(name)) {
    result = convertGsdx(input, limits, { parseXml, decodeXml });
  } else {
    const unpacked = extractXml(input, limits), decoded = decodeXml(unpacked.bytes);
    result = { ...parseXml(decoded.text, limits), container: unpacked.kind, member: unpacked.member,
      encoding: decoded.encoding };
  }
  const digest = await crypto.subtle.digest('SHA-256', input);
  return { ...result, name, bytes: input.length,
    sha256: [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join(''),
    formulaEvaluated: false };
}

export const POSITION_COLUMNS = [
  ['file', 'Файл'], ['chapter', 'Раздел'], ['number', '№'], ['code', 'Код'], ['name', 'Наименование'],
  ['unit', 'Ед. изм.'], ['quantity', 'Количество'], ['formula', 'Формула количества'], ['priceLevel', 'Уровень цен'],
  ['basePZ', 'ПЗ, базисные'], ['baseOZ', 'Оплата труда, базисная'], ['baseEM', 'Эксплуатация машин, базисная'],
  ['baseZM', 'Оплата машинистов, базисная'], ['baseMT', 'Материалы, базисные'], ['currentPZ', 'ПЗ, текущие'], ['systemId', 'ID позиции'],
  ['path', 'Путь в источнике'], ['sourceHash', 'SHA-256 файла']
];
export const FIELD_COLUMNS = [['file', 'Файл'], ['path', 'Путь в источнике'], ['kind', 'Тип'], ['key', 'Поле'], ['value', 'Значение'], ['sourceHash', 'SHA-256 файла']];

const GSDX_COMMON = [['file', 'Файл'], ['folders', 'Папки каталога'], ['documentId', 'ID документа'],
  ['code', 'Обозначение'], ['name', 'Наименование']];
const GSDX_PROVENANCE = [['path', 'Путь в источнике'], ['numericStatus', 'Извлечение числовых данных'],
  ['approved', 'Допущено к расчётам'], ['sourceHash', 'SHA-256 файла']];
export const DATASET_COLUMNS = {
  records: [['file', 'Файл'], ['rowIndex', 'ID записи (с нуля)'], ['code', 'Код из индекса'],
    ['searchText', 'Поисковые слова по порядку'], ['tokenCount', 'Слов в индексе'], ['tokenGaps', 'Пропущенных позиций слов'],
    ['indexStatus', 'Состав данных'], ['searchBlock', 'Блок поискового индекса'],
    ['rowOffset', 'Смещение DocRows в файле'], ['rowBytes', 'Байт записи DocRows'], ...GSDX_PROVENANCE],
  catalog: [...GSDX_COMMON, ['articleAvailable', 'Техническая часть доступна'], ...GSDX_PROVENANCE],
  pages: [...GSDX_COMMON, ['page', 'Страница'], ['text', 'Текст'], ['encoding', 'Кодировка страницы'],
    ['block', 'Блок'], ['decodedOffset', 'Смещение в распакованном блоке'], ['decodedLength', 'Байт HTML'],
    ['assets', 'Вложений'], ['trailerBytes', 'Неразобранных байт в конце статьи'], ...GSDX_PROVENANCE],
  blocks: [['file', 'Файл'], ['block', 'Блок'], ['offset', 'Смещение в файле'], ['length', 'Байт'],
    ['status', 'Статус разбора'], ['signature', 'Сигнатура HEX'], ...GSDX_PROVENANCE]
};

export function rowsFor(results, mode = 'positions', extras = true) {
  const columns = [...(DATASET_COLUMNS[mode] || (mode === 'fields' ? FIELD_COLUMNS : POSITION_COLUMNS))];
  const rows = [], keys = new Set(columns.map(c => c[0]));
  for (const result of results) for (const source of (mode === 'positions' ? result.positions : result[mode]) || []) {
    const row = { ...source, file: result.name, sourceHash: result.sha256 || '' };
    if (mode === 'positions' && extras) for (const [key, value] of Object.entries(source.raw)) {
      const field = 'xml:' + key;
      row[field] = value;
      if (!keys.has(field)) { keys.add(field); columns.push([field, 'XML: ' + key]); }
    }
    rows.push(row);
  }
  return { columns, rows };
}

export function filterRows(rows, query, columns) {
  const q = query.trim().toLocaleLowerCase('ru');
  return q ? rows.filter(r => columns.some(([key]) => String(r[key] ?? '').toLocaleLowerCase('ru').includes(q))) : rows;
}

export function csvCell(value, delimiter, protect = true) {
  let text = String(value ?? '');
  // Protect spreadsheet formulas in text. Numeric literals keep their exact representation.
  if (protect && !literal(text) && /^[\s\u0000-\u001f]*[=+\-@]/.test(text)) text = "'" + text;
  return text.includes(delimiter) || /["\r\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
}

export function makeCsv(rows, columns, { delimiter = ';', bom = true, protect = true } = {}) {
  if (![';', ',', '\t'].includes(delimiter)) throw new Error('Invalid CSV delimiter');
  if (rows.length * columns.length > 5000000)
    fail('csv_width', 'CSV получается слишком широким. Отключите «Исходные поля позиции» или выберите режим «Все XML-поля».');
  const lines = [columns.map(([, title]) => csvCell(title, delimiter, protect)).join(delimiter)];
  let length = lines[0].length;
  for (const row of rows) {
    const line = columns.map(([key]) => csvCell(row[key], delimiter, protect)).join(delimiter);
    length += line.length + 2;
    if (length > 120000000) fail('csv_limit', 'Результат больше 120 млн символов. Выберите один файл или сократите выборку.');
    lines.push(line);
  }
  return (bom ? '\ufeff' : '') + lines.join('\r\n') + '\r\n';
}
