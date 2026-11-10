import { Inflate } from 'pako';
import { Parser } from 'htmlparser2';
import { ConversionError } from './errors.js';

const fail = message => { throw new ConversionError('gsdx', message); };
const cp1251 = new TextDecoder('windows-1251', { fatal: true });
const MiB = 1024 * 1024;

// Observed SDB5 layout, shared with grand_parser/binary.py. No numeric GSH decoding.
export function gsdxDirectory(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const integer = (p, wide = false) => {
    if (p < 0 || p + (wide ? 8 : 4) > bytes.length) fail('Обрезано целое число GSDX.');
    const n = wide ? Number(view.getBigUint64(p, true)) : view.getUint32(p, true);
    if (!Number.isSafeInteger(n)) fail('Некорректное смещение GSDX.');
    return n;
  };
  if (bytes.length < 20 || bytes[0] !== 83 || bytes[1] !== 68 || bytes[2] !== 66 || bytes[3] !== 5)
    fail('Неизвестная версия GSDX: поддерживается сигнатура SDB5.');
  const count = integer(8), directory = integer(12);
  if (count < 1 || count > 50000 || directory < 20 || directory > bytes.length) fail('Повреждён заголовок каталога GSDX.');
  let p = 20;
  const names = [], unique = new Set();
  for (let i = 0; i < count; i++) {
    if (p + 2 > directory || bytes[p] !== 1) fail('Повреждена запись имени блока GSDX.');
    const length = bytes[p + 1], end = p + 2 + length;
    if (!length || end >= directory || bytes[end] !== 0) fail('Повреждена длина имени блока GSDX.');
    const name = cp1251.decode(bytes.subarray(p + 2, end));
    if (unique.has(name)) fail('Каталог GSDX содержит повторяющиеся имена блоков.');
    unique.add(name); names.push(name); p = end + 1;
  }
  const payloadStart = directory + count * 12;
  if (p !== directory || payloadStart > bytes.length) fail('Повреждена таблица блоков GSDX.');
  const blocks = names.map((name, i) => {
    const offset = integer(directory + i * 12, true), length = integer(directory + i * 12 + 8);
    if (offset < payloadStart || offset + length > bytes.length) fail(`Блок GSDX за пределами файла: ${name}`);
    return { name, offset, length };
  });
  let end = payloadStart;
  for (const block of [...blocks].sort((a, b) => a.offset - b.offset)) {
    if (block.offset < end) fail(`Пересекаются блоки GSDX: ${block.name}`);
    end = block.offset + block.length;
  }
  return blocks;
}

export function inflateGsdx(bytes, limit = 64 * MiB) {
  if (bytes.length < 5) fail('Обрезан сжатый блок GSDX.');
  const expected = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
  if (!expected || expected > limit) fail('Распакованный блок GSDX превышает допустимый размер.');
  const inflater = new Inflate({ raw: true, chunkSize: 65536 });
  const parts = []; let total = 0;
  inflater.onData = part => {
    total += part.length;
    if (total > expected) fail('Размер распакованного GSDX не совпадает с заголовком.');
    parts.push(part);
  };
  inflater.push(bytes.subarray(4), true);
  if (inflater.err || !inflater.ended || total !== expected || inflater.strm.next_in !== bytes.length - 4)
    fail('Повреждён DEFLATE-блок GSDX: размер, конец потока или лишние байты.');
  const result = new Uint8Array(total); let p = 0;
  for (const part of parts) { result.set(part, p); p += part.length; }
  return result;
}

export function gsdxPages(data) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const integer = (p, wide = false, bound = data.length) => {
    if (p < 0 || p + (wide ? 8 : 4) > bound) fail('Обрезана HTML-страница GSDX.');
    const n = wide ? Number(view.getBigUint64(p, true)) : view.getUint32(p, true);
    if (!Number.isSafeInteger(n)) fail('Некорректный размер HTML-страницы.');
    return n;
  };
  const tagEnd = (p, tag, bound = data.length) => {
    if (p < 0 || p + 5 > bound || data[p] !== tag) fail('Повреждён контейнер HTML-страниц GSDX.');
    const size = integer(p + 1, false, bound), end = p + 1 + size;
    if (size < 4 || end > bound) fail('HTML-запись выходит за границы блока.');
    return end;
  };
  const ascii = (p, size) => String.fromCharCode(...data.subarray(p, p + size));
  if (data.length < 37 || ascii(0, 5) !== 'HTML\x02' || ascii(9, 4) !== 'HTML' || integer(5) !== data.length - 5 || integer(13) !== 1)
    fail('Неподдерживаемый заголовок HTML2 в GSDX.');
  const count = integer(33);
  if (count > 100000) fail('Слишком много HTML-страниц GSDX.');
  const pages = []; let p = 37;
  for (let i = 0; i < count; i++) {
    const end = tagEnd(p, 1);
    if (tagEnd(p + 5, 2, end) !== end) fail('Некорректная вложенная HTML-запись.');
    const size = integer(p + 10, true, end), start = p + 18, tail = start + size;
    if (tail + 2 > end || data[tail] !== 0 || ![0, 1].includes(data[tail + 1])) fail('Некорректный конец HTML-страницы.');
    const html = data.subarray(start, tail);
    // Validate the HTML boundary without decoding embedded assets as markup.
    const leading = new TextDecoder().decode(html.subarray(0, 128)).trimStart().toLowerCase();
    const trailing = new TextDecoder().decode(html.subarray(Math.max(0, html.length - 128))).trimEnd().toLowerCase();
    if (!leading.startsWith('<html') || !trailing.endsWith('</html>')) fail('Некорректные границы HTML-страницы.');
    const assetsStart = tail + 2;
    if (tagEnd(assetsStart, 1, end) !== end) fail('Повреждён список вложений HTML-страницы.');
    const assets = integer(assetsStart + 5, false, end);
    if (assets > 100000) fail('Слишком много вложений HTML-страницы.');
    let cur = assetsStart + 9;
    for (let a = 0; a < assets; a++) {
      const assetEnd = tagEnd(cur, 1, end), nameSize = integer(cur + 5, false, assetEnd);
      const contentSizePos = cur + 9 + nameSize;
      const contentSize = integer(contentSizePos, true, assetEnd);
      if (contentSizePos + 8 + contentSize !== assetEnd) fail('Неверный размер вложения HTML-страницы.');
      cur = assetEnd;
    }
    if (cur !== end) fail('Лишние данные в списке HTML-вложений.');
    pages.push({ html, page: i + 1, decodedOffset: start, decodedLength: size, assets });
    p = end;
  }
  return { pages, trailer: data.length - p };
}

export function gsdxHtmlText(bytes) {
  const header = cp1251.decode(bytes.subarray(0, 4096));
  const declared = /charset\s*=\s*["']?([\w-]+)/i.exec(header)?.[1];
  let html, encoding;
  for (const candidate of [...(declared ? [declared] : []), 'utf-8', 'windows-1251']) {
    try { html = new TextDecoder(candidate, { fatal: true }).decode(bytes); encoding = candidate; break; } catch {}
  }
  if (html == null) fail('Не удалось прочитать кодировку HTML-страницы GSDX.');
  const breaks = new Set(['p', 'div', 'br', 'tr', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
  const parts = []; let skip = 0;
  const parser = new Parser({
    onopentag(tag) {
      if (['script', 'style', 'head'].includes(tag)) skip++;
      if (!skip) { if (breaks.has(tag)) parts.push('\n'); else if (['td', 'th'].includes(tag)) parts.push(' | '); }
    },
    onclosetag(tag) {
      if (['script', 'style', 'head'].includes(tag)) skip = Math.max(0, skip - 1);
      else if (!skip && breaks.has(tag)) parts.push('\n');
    },
    ontext(text) { if (!skip) parts.push(text); }
  }, { decodeEntities: true });
  parser.end(html);
  const text = parts.join('').split(/\r?\n/).map(line => line.replace(/\s+/g, ' ').trim().replace(/^\|+|\|+$/g, '').trim()).filter(Boolean).join('\n');
  return { text, encoding };
}

export function convertGsdx(bytes, limits, { parseXml, decodeXml }) {
  const blocks = gsdxDirectory(bytes), byName = new Map(blocks.map(b => [b.name, b])), decoded = new Set();
  const fields = [], catalog = [], pages = [], budget = { bytes: 0 };
  const read = name => {
    const b = byName.get(name);
    if (!b) fail(`В GSDX отсутствует блок ${name}.`);
    const value = inflateGsdx(bytes.subarray(b.offset, b.offset + b.length), Math.min(limits.xml, 256 * MiB - budget.bytes));
    budget.bytes += value.length; decoded.add(name); return value;
  };
  const xml = name => {
    const value = parseXml(decodeXml(read(name)).text, limits);
    if (fields.length + value.fields.length > limits.fields) fail('Слишком много XML-полей в GSDX.');
    for (const field of value.fields) fields.push({ ...field, path: name + ':' + field.path });
    return value;
  };
  const content = xml('Content'), documents = new Map(), folders = new Map();
  for (const node of content.elements || []) if (node.local === 'Document') documents.set(node.path, {});
  for (const field of content.fields) {
    if (field.kind !== 'Атрибут') continue;
    if (/\/Folder\[\d+\]$/.test(field.path) && field.key === 'Caption') folders.set(field.path, field.value);
    if (/\/Document\[\d+\]$/.test(field.path)) {
      if (!documents.has(field.path)) documents.set(field.path, {});
      documents.get(field.path)[field.key] = field.value;
    }
  }
  if (byName.has('Zones')) xml('Zones');
  const ids = new Set();
  for (const [path, attrs] of documents) {
    const rawId = attrs.ID ?? '0';
    if (!/^\d+$/.test(rawId)) fail('Неподдерживаемый ID документа в каталоге GSDX.');
    const id = BigInt(rawId).toString();
    if (ids.has(id)) fail('Неоднозначные ID документов GSDX, включая пропущенный ID=0.');
    ids.add(id);
    const article = id + '\\Article2', outline = id + '\\ArticleContent';
    const common = { documentId: id, code: attrs.Sign || '', name: attrs.Caption || '',
      folders: [...folders].filter(([folder]) => path.startsWith(folder + '/')).map(([, caption]) => caption).join(' / '),
      numericStatus: 'unsupported_binary_payload', approved: 'false' };
    catalog.push({ ...common, articleAvailable: byName.has(article) ? 'true' : 'false', path: 'Content:' + path });
    if (byName.has(outline)) xml(outline);
    if (!byName.has(article)) continue;
    const articleData = gsdxPages(read(article));
    for (const page of articleData.pages) {
      if (pages.length >= limits.positions) fail('Слишком много страниц GSDX.');
      const { text, encoding } = gsdxHtmlText(page.html);
      pages.push({ ...common, ...page, html: undefined, text, encoding, block: article,
        trailerBytes: articleData.trailer, path: `${article}:page:${page.page}` });
    }
  }
  const blockRows = blocks.map(b => ({ block: b.name, offset: b.offset, length: b.length,
    path: b.name, status: decoded.has(b.name) ? 'decoded' : 'uninterpreted',
    signature: [...bytes.subarray(b.offset, b.offset + Math.min(12, b.length))].map(x => x.toString(16).padStart(2, '0')).join(''),
    numericStatus: 'unsupported_binary_payload', approved: 'false' }));
  return { positions: [], fields, catalog, pages, blocks: blockRows, container: 'GSDX / SDB5', member: null,
    encoding: 'windows-1251 / HTML', root: content.root, documentType: '', nodes: content.nodes,
    numericExtraction: 'unsupported_binary_payload', approvedForCalculation: false,
    warnings: ['GSDX прочитан частично: доступны каталог, XML-структура и технические тексты. Расценки, нормы расхода и числовые ресурсы из бинарных блоков не декодируются. Тексты предназначены для поиска и ИИ-агента, не для расчёта сметы.'] };
}
