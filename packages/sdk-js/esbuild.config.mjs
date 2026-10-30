// @clickroom/sdk-js — build script. Produces the CDN IIFE bundle and the npm ESM entry.
// Type declarations are emitted separately via `tsc --emitDeclarationOnly` (see package.json build script).
import { build } from 'esbuild'

const shared = {
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
}

// CDN bundle: loaded by the <script> snippet, exposes window.clickroom.
// No sourcemap, unlike the other targets: this is the only bundle served to third-party pages
// (capture's GET /static/clickroom.js), and nothing serves the .map alongside it — so the
// `sourceMappingURL` comment would just 404 in every customer's devtools. Emitting the map here
// would also mean publishing the SDK's full TypeScript source from the ingest host. Bundler
// consumers still get maps via the esm/eval entries below.
const cdn = build({
  ...shared,
  sourcemap: false,
  entryPoints: ['src/global.ts'],
  outfile: 'dist/clickroom.js',
  format: 'iife',
  minify: true,
  target: 'es2018',
})

// npm ESM entry: consumed by bundlers via the package "exports" map.
const esm = build({
  ...shared,
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  format: 'esm',
  minify: false,
  target: 'es2020',
})

// Pure eval entry: DOM-free flag hash/evaluate for non-browser consumers (`./eval` subpath).
const evalEntry = build({
  ...shared,
  entryPoints: ['src/eval.ts'],
  outfile: 'dist/eval.js',
  format: 'esm',
  minify: false,
  target: 'es2020',
})

// Headless React API entry (`./react` subpath): survey hooks for teams rendering their own UI.
// `react` is a PEER dep — marked external so it is NOT bundled (the host app supplies its single
// React instance; bundling a copy would break hooks / dedupe). Tree-shakeable, no side effects.
//
// `./index` is ALSO external: react.ts imports the client singletons (supportClient / surveyClient
// held in index.ts's module-level `state`) from `./index`. If bundled, dist/react.js would inline
// its OWN copy of that state — a second singleton the app's init() never touches — so
// getSupportClient()/getSurveyClient() return null from the react bundle. Marking it external emits
// `import { ... } from './index.js'`, which ESM resolves to the SAME dist/index.js module instance
// the app already loads via the `@clickroom/sdk-js` main export → one shared singleton.
const reactEntry = build({
  ...shared,
  entryPoints: ['src/react.ts'],
  outfile: 'dist/react.js',
  format: 'esm',
  minify: false,
  target: 'es2020',
  external: ['react', './index.js'],
})

// Minified CDN loader stub: the literal snippet pasted into customer <head> tags.
// This is the single source of truth — README.md, the marketing site, and the
// /setup page's HTML guide all embed this build's output (dist/loader.min.js)
// verbatim; don't hand-edit those copies, regenerate from loader.js instead.
const loader = build({
  ...shared,
  entryPoints: ['loader.js'],
  outfile: 'dist/loader.min.js',
  format: 'iife',
  minify: true,
  target: 'es2018',
})

await Promise.all([cdn, esm, evalEntry, reactEntry, loader])
