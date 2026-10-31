// Bundles the Electron main process and preload. The preload must be CommonJS, and self-contained, because it runs sandboxed.
import { build } from 'esbuild';

const common = { bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], sourcemap: true, logLevel: 'info' };
// The extension libraries stay in node_modules: they find their own page preloads relative to themselves.
const extensionLibs = ['electron-chrome-extensions', 'electron-chrome-web-store'];
await Promise.all([
  build({ ...common, entryPoints: ['src/main/main.ts'], outfile: 'out/main.cjs', external: [...common.external, ...extensionLibs] }),
  build({ ...common, entryPoints: ['src/main/preload.ts'], outfile: 'out/preload.cjs' }),
  // Sign-in fields in web pages (registered on each Profile session).
  build({ ...common, entryPoints: ['src/main/pagePreload.ts'], outfile: 'out/pagePreload.cjs' }),
]);
