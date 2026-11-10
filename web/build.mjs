import { build } from 'esbuild';
import { mkdir, copyFile, rm, readFile, writeFile } from 'node:fs/promises';

await rm(new URL('./dist/', import.meta.url), { recursive: true, force: true });
await mkdir(new URL('./dist/examples/', import.meta.url), { recursive: true });
await build({ entryPoints: ['src/app.js', 'src/converter.worker.js'], bundle: true, outdir: 'dist',
  format: 'esm', platform: 'browser', target: ['es2022'], minify: true, legalComments: 'eof' });
for (const name of ['index.html', 'style.css']) await copyFile('src/' + name, 'dist/' + name);
await copyFile('../examples/synthetic_estimate.gsfx', 'dist/examples/synthetic_estimate.gsfx');
const notices = [];
for (const name of ['fflate', 'saxes', 'xmlchars']) {
  const metadata = JSON.parse(await readFile(`node_modules/${name}/package.json`, 'utf8'));
  let license;
  for (const candidate of ['LICENSE', 'LICENSE.md', 'LICENSE.txt']) {
    try { license = await readFile(`node_modules/${name}/${candidate}`, 'utf8'); break; } catch {}
  }
  if (!license && name === 'saxes') license = await readFile('licenses/saxes-LICENSE', 'utf8');
  if (!license) throw new Error(`Missing license for ${name}`);
  notices.push(`${name} ${metadata.version}\n${license}`);
}
await writeFile('dist/THIRD_PARTY_NOTICES.txt', notices.join('\n\n------\n\n'));
console.log('Static converter built: dist/');
