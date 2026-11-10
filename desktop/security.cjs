'use strict';
const ALLOWED_ASSETS = new Set([
  'index.html', 'app.js', 'converter.worker.js', 'style.css',
  'THIRD_PARTY_NOTICES.txt', 'examples/synthetic_estimate.gsfx'
]);
const EXTERNAL_HOSTS = new Set(['github.com', 'grandsmeta.ru', 'www.grandsmeta.ru', 'help.grandsmeta.ru', '66.grandsmeta.ru']);
function isAppUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'grandcsv:' && url.hostname === 'app' && !url.port && !url.username && !url.password;
  } catch { return false; }
}
function assetForUrl(value) {
  if (!isAppUrl(value)) return null;
  try {
    const decoded = decodeURIComponent(new URL(value).pathname);
    if (/[\\\0]/.test(decoded) || decoded.split('/').some(p => p === '..' || p === '.')) return null;
    const name = decoded === '/' ? 'index.html' : decoded.slice(1);
    return ALLOWED_ASSETS.has(name) ? name : null;
  } catch { return null; }
}
function isAllowedExternal(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && EXTERNAL_HOSTS.has(url.hostname);
  } catch { return false; }
}
module.exports = { isAppUrl, assetForUrl, isAllowedExternal };
