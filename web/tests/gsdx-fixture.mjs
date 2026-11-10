import { deflateRawSync } from 'node:zlib';
const uint = (n, size = 4) => { const b = Buffer.alloc(size); size === 8 ? b.writeBigUInt64LE(BigInt(n)) : b.writeUInt32LE(n); return b; };
const record = (tag, body) => Buffer.concat([Buffer.from([tag]), uint(body.length + 4), body]);
export const packed = bytes => Buffer.concat([uint(bytes.length), deflateRawSync(bytes)]);
export function article(htmls, { assets = false, trailer = Buffer.alloc(0) } = {}) {
  const entries = htmls.map(html => {
    const bytes = Buffer.from(html);
    const name = Buffer.from('ignored.html'), payload = Buffer.from('<html>ASSET_NOT_A_PAGE<script>bad()</script></html>');
    const attachment = assets ? record(1, Buffer.concat([uint(name.length), name, uint(payload.length, 8), payload])) : Buffer.alloc(0);
    const assetList = record(1, Buffer.concat([uint(assets ? 1 : 0), attachment]));
    return record(1, record(2, Buffer.concat([uint(bytes.length, 8), bytes, Buffer.from([0, 1]), assetList])));
  });
  const body = Buffer.concat([Buffer.from('HTML'), uint(1), ...Array(4).fill(uint(1000)), uint(htmls.length), ...entries, trailer]);
  return Buffer.concat([Buffer.from('HTML\x02'), uint(body.length + 4), body]);
}
export function container(blocks) {
  const names = Buffer.concat(Object.keys(blocks).map(name => {
    const bytes = Buffer.from(name); return Buffer.concat([Buffer.from([1, bytes.length]), bytes, Buffer.from([0])]);
  }));
  const directory = 20 + names.length;
  let offset = directory + Object.keys(blocks).length * 12;
  const records = Object.values(blocks).map(bytes => { const value = Buffer.concat([uint(offset, 8), uint(bytes.length)]); offset += bytes.length; return value; });
  return new Uint8Array(Buffer.concat([Buffer.from('SDB\x05'), uint(12), uint(records.length), uint(directory), uint(0xffffffff), names, ...records, ...Object.values(blocks)]));
}
export const firstHtml = '<html><head><meta charset="utf-8"><title>HIDDEN_TITLE</title><style>HIDDEN_STYLE</style></head><body><p>Техническая часть &amp; условия</p><table><tr><td>Сталь</td><td>100 м2</td></tr></table><script>HIDDEN_SCRIPT</script></body></html>';
export function fixture(catalog = '<Region Caption="Кемеровская область"><Folder Caption="ТЕР"><Document ID="1" Sign="ТЕР13" Caption="Коррозия"/><Document Caption="Без статьи"/></Folder></Region>') {
  return container({ Content: packed(Buffer.from(catalog)), Zones: packed(Buffer.from('<Zones><Zone ID="1" Caption="Кемерово"/></Zones>')),
    '1\\ArticleContent': packed(Buffer.from('<Contents><Item Caption="Общие положения"/></Contents>')),
    '1\\Article2': packed(article([firstHtml, '<html><body><p>Вторая страница</p></body></html>'], { assets: true, trailer: Buffer.from('UNINTERPRETED_TRAILER') })),
    '1\\Data': Buffer.from('GSH\x03UNKNOWN_NUMERIC') });
}
