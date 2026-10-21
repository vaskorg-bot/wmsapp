// Builds www/: transpiles the app for older Android WebViews and bundles fonts for offline use.
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const www = path.join(root, 'www');
const target = ['chrome61'];

fs.rmSync(www, { recursive: true, force: true });
fs.mkdirSync(path.join(www, 'fonts'), { recursive: true });

await esbuild.build({ entryPoints: [path.join(root, 'src/native.js')], bundle: true, format: 'iife', target, minify: true, outfile: path.join(www, 'native.js'), logLevel: 'warning' });
await esbuild.build({ entryPoints: [path.join(root, 'src/app.js')], bundle: false, target, minify: true, outfile: path.join(www, 'app.js'), logLevel: 'warning' });

// Latin + Latin Extended (Hungarian) subsets only, woff2 only
const faces = [['barlow', [400, 500, 600]], ['barlow-condensed', [600, 700]], ['ibm-plex-mono', [500, 600]]];
let css = '';
for (const [pkg, weights] of faces) {
  const dir = path.join(root, 'node_modules/@fontsource', pkg);
  for (const w of weights) {
    const src = fs.readFileSync(path.join(dir, `${w}.css`), 'utf8');
    for (const block of src.split('@font-face').slice(1)) {
      const m = block.match(/url\(\.\/files\/([^)]+?-latin(?:-ext)?-\d+-normal\.woff2)\)/);
      if (!m) continue;
      fs.copyFileSync(path.join(dir, 'files', m[1]), path.join(www, 'fonts', m[1]));
      const body = block.replace(/src:[^;]+;/, `src: url(fonts/${m[1]}) format('woff2');`).trim();
      css += '@font-face ' + body.replace(/\/\*[^*]*\*\/\s*$/, '').trim() + '\n';
    }
  }
}
const html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8').replace('/*FONTS*/', css);
fs.writeFileSync(path.join(www, 'index.html'), html);
console.log('www built:', fs.readdirSync(path.join(www, 'fonts')).length, 'font files');
