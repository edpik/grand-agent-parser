const test = require('node:test');
const assert = require('node:assert/strict');
const { assetForUrl, isAppUrl, isAllowedExternal } = require('../security.cjs');

test('desktop serves only bundled assets from its own origin', () => {
  assert.equal(assetForUrl('grandcsv://app/'), 'index.html');
  assert.equal(assetForUrl('grandcsv://app/converter.worker.js'), 'converter.worker.js');
  assert.equal(assetForUrl('grandcsv://app/examples/synthetic_estimate.gsfx'), 'examples/synthetic_estimate.gsfx');
  for (const url of ['grandcsv://app/%2e%2e%2fmain.cjs', 'grandcsv://app/%5c..%5csecret', 'grandcsv://app/%00',
    'grandcsv://app/%zz', 'grandcsv://app/main.cjs', 'grandcsv://other/app.js', 'file:///etc/passwd',
    'grandcsv://user@app/app.js', 'grandcsv://app:443/app.js']) assert.equal(assetForUrl(url), null, url);
  assert.equal(isAppUrl('https://app/index.html'), false);
});

test('external navigation allows only documented HTTPS destinations', () => {
  assert.equal(isAllowedExternal('https://github.com/edpik/grand-agent-parser'), true);
  assert.equal(isAllowedExternal('https://66.grandsmeta.ru/upload/iblock/cff/WorkWithXML6.pdf'), true);
  for (const url of ['javascript:alert(1)', 'file:///tmp/file', 'https://evil.github.com/',
    'https://github.com.evil.test/', 'http://github.com/', 'https://user@github.com/', 'https://github.com:444/'])
    assert.equal(isAllowedExternal(url), false, url);
});
