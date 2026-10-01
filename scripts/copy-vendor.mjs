// Copies the CAD import libraries (rhino3dm, OpenCascade) into public/vendor so the site serves
// them itself: importing .3dm / STEP / IGES needs no CDN and no network. Runs before dev/build.
import { copyFileSync, mkdirSync } from 'node:fs';

const out = 'public/vendor';
mkdirSync(out, { recursive: true });
for (const f of ['rhino3dm/rhino3dm.module.min.js', 'rhino3dm/rhino3dm.wasm', 'occt-import-js/dist/occt-import-js.js', 'occt-import-js/dist/occt-import-js.wasm'])
  copyFileSync(`node_modules/${f}`, `${out}/${f.split('/').pop()}`);
console.log('vendor libraries copied to', out);
