// Turns dist/index.html into the page published online (publish/index.html):
// styles inlined, app code served next to it as assets/app.js. The artifact host doesn't serve
// .glb files, so the 3D model goes along base64-encoded in models/shahrofar.glb.json; the same goes
// for the HDRI (env/*.hdr -> env/*.hdr.json, see src/environment.js; without it the viewer keeps
// its procedural sky environment).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';

const html = readFileSync('dist/index.html', 'utf8');
const title = html.match(/<title>(.*?)<\/title>/)[1];
const cssHref = html.match(/<link rel="stylesheet"[^>]*href="\.\/([^"]+)"/)[1];
const css = readFileSync(`dist/${cssHref}`, 'utf8');
const body = html.match(/<body>([\s\S]*)<\/body>/)[1].trim();

mkdirSync('publish/assets', { recursive: true });
mkdirSync('publish/models', { recursive: true });
const app = readFileSync('dist/assets/app.js', 'utf8');
if (!app.includes('models/shahrofar.glb')) throw new Error('model URL not found in app.js');
let appOut = app.replaceAll('models/shahrofar.glb', 'models/shahrofar.glb.json');
const HDR = 'env/san_giuseppe_bridge_1k.hdr';
if (app.includes(HDR) && existsSync(`dist/${HDR}`)) {
  mkdirSync('publish/env', { recursive: true });
  writeFileSync(`publish/${HDR}.json`, JSON.stringify({ hdr: readFileSync(`dist/${HDR}`).toString('base64') }));
  appOut = appOut.replaceAll(HDR, `${HDR}.json`);
}
writeFileSync('publish/assets/app.js', appOut);
const glb = readFileSync('dist/models/shahrofar.glb');
writeFileSync('publish/models/shahrofar.glb.json', JSON.stringify({ glb: glb.toString('base64') }));
writeFileSync(
  'publish/index.html',
  `<title>${title}</title>\n<style>${css}</style>\n${body}\n<script type="module" src="assets/app.js"></script>\n`,
);
console.log('publish/index.html ready');
