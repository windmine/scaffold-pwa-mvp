import { computePwaCacheVersion, writeServiceWorker } from './pwa-shell-assets.mjs';

writeServiceWorker(process.cwd());
console.log(`generated sw.js (${computePwaCacheVersion(process.cwd())})`);
