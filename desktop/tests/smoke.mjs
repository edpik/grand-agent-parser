import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { indexedFixture } from '../../web/tests/gsdx-fixture.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = process.env.SMOKE_OUTPUT || await mkdtemp(path.join(tmpdir(), 'grand-csv-smoke-'));
await mkdir(output, { recursive: true });
const args = process.env.ELECTRON_APP_BINARY ? [] : [path.join(root, 'desktop')];
if (process.platform === 'linux') args.push('--no-sandbox', '--disable-gpu', '--ozone-platform=headless');
const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: process.env.ELECTRON_APP_BINARY || undefined,
  args, env: environment, timeout: 60000 });
const errors = [];
try {
  const page = await app.firstWindow({ timeout: 60000 });
  page.on('pageerror', error => errors.push(error.message));
  await page.locator('#choose-files').waitFor();
  assert.equal(page.url(), 'grandcsv://app/index.html');
  const globals = await page.evaluate(() => ({ secure: isSecureContext, crypto: !!crypto.subtle,
    require: typeof globalThis.require, node: typeof globalThis.process }));
  assert.deepEqual(globals, { secure: true, crypto: true, require: 'undefined', node: 'undefined' });
  const packaged = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, version: app.getVersion() }));
  if (process.env.ELECTRON_APP_BINARY) assert.equal(packaged.packaged, true);
  const csvPath = path.join(output, 'saved.csv');
  await app.evaluate(({ session }, savePath) => {
    globalThis.smokeDownload = new Promise(resolve => session.fromPartition('grandcsv-memory').once('will-download', (_event, item) => {
      item.setSavePath(savePath); item.once('done', (_e, state) => resolve({ state, path: item.getSavePath() }));
    }));
  }, csvPath);

  // The demo must be served from the bundled files, with a real module Worker.
  await page.locator('#demo').click();
  await page.waitForFunction(() => document.querySelector('#table-body').children.length === 2);
  assert.match(await page.locator('#table-body').innerText(), /2\.500000/);
  await page.locator('#download').click();
  const download = await app.evaluate(async () => await globalThis.smokeDownload);
  assert.equal(download.state, 'completed');
  assert.match(await readFile(csvPath, 'utf8'), /TEST-001/);
  const csv = await readFile(csvPath); assert.deepEqual([...csv.subarray(0, 3)], [239, 187, 191]);

  await page.locator('#clear').click();
  await page.locator('#file-input').setInputFiles({ name: 'Materials.gsdx', mimeType: 'application/octet-stream', buffer: Buffer.from(indexedFixture()) });
  await page.locator('#convert').click();
  await page.waitForFunction(() => document.querySelector('#dataset').value === 'records' && document.querySelector('#table-body').children.length === 2);
  assert.match(await page.locator('#table-body').innerText(), /truck 10/);
  assert.match(await page.locator('#status').innerText(), /не прочитаны/);

  if (process.env.GSDX_TEST_FILE) {
    await page.locator('#clear').click();
    await page.locator('#file-input').setInputFiles(process.env.GSDX_TEST_FILE);
    await page.locator('#convert').click();
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('620 записей'), null, { timeout: 60000 });
    assert.match(await page.locator('#row-count').innerText(), /620/);
    assert.match(await page.locator('#table-body').innerText(), /автобитумовоз/);
  }
  const denied = await page.evaluate(async () => {
    try { await fetch('https://example.com'); return false; } catch { return true; }
  });
  assert.equal(denied, true, 'Desktop renderer must not make external HTTP requests');
  assert.equal(await page.evaluate(async () => (await fetch('grandcsv://app/secret.txt')).status), 404);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(output, 'desktop.png') });
  await writeFile(path.join(output, 'result.json'), JSON.stringify({ ...packaged, platform: process.platform,
    arch: process.arch, demoRows: 2, gsdxRows: process.env.GSDX_TEST_FILE ? 620 : 2, download: 'verified',
    secureContext: globals.secure, externalRequests: 'blocked', errors }, null, 2));
  console.log(`Desktop smoke test passed: ${output}`);
} finally { await app.close(); }
