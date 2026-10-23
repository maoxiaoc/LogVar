import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
const target = process.argv.includes('--rex') ? 'rex' : 'forward';
const { default: metadata } = await import(`../${target}/metadata.js`);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = await readFile(path.join(root, 'forward/runtime.js'), 'utf8');
const noStorage = 'export async function setLocalRedisKey() {} export async function updateLocalRedisCaches() {}';
const stubs = {
  'node:async_hooks': 'export class AsyncLocalStorage { getStore() { return undefined; } run(store, fn, ...args) { return fn(...args); } }',
  'node:http': 'export default { Agent: class Agent {} };',
  'node:https': 'export default { Agent: class Agent {} };',
  'fs': 'export default {};',
  'path': 'export default {};',
  'redis': 'export function createClient() { throw new Error("Redis is unavailable in Forward"); }',
  'node-fetch': 'export default function() { throw new Error("Network must use Widget.http"); }',
  'local-redis-util.js': noStorage,
  'bangumi-data-util.js': 'export async function ensureBangumiDataReady() { return false; } export async function searchBangumiData() { return []; }',
  'dan-any.js': 'export const danAnyFormats = []; export function convertDanAny() { return null; }',
};

const result = await build({
  absWorkingDir: root,
  entryPoints: ['forward/widget.js'],
  bundle: true,
  write: false,
  format: 'iife',
  globalName: 'LogvarForward',
  target: 'es2020',
  platform: 'neutral',
  minifySyntax: true,
  metafile: true,
  define: {
    'globalThis.__FORWARD_WIDGET__': 'true',
    'globalThis.__WIDGET_TMDB_PREFIX__': JSON.stringify(target === 'rex' ? '' : '/'),
  },
  plugins: [{
    name: 'forward-host',
    setup(builder) {
      builder.onLoad({ filter: /[\\/]forward[\\/]metadata\.js$/ }, () => ({
        contents: `export default ${JSON.stringify(metadata)};`, loader: 'js',
      }));
      builder.onResolve({ filter: /^(?:node:.*|fs|path|redis|node-fetch)$|(?:^|[\\/])(?:local-redis-util|bangumi-data-util|dan-any)\.js$/ }, args => {
        const name = args.path.startsWith('node:') ? args.path : args.path.split(/[\\/]/).pop();
        if (!(name in stubs)) throw new Error(`Unexpected native dependency: ${args.path}`);
        return { path: name, namespace: 'forward-stub' };
      });
      builder.onLoad({ filter: /.*/, namespace: 'forward-stub' }, args => ({ contents: stubs[args.path], loader: 'js' }));
      builder.onResolve({ filter: /^\.\/dictionary-data$/ }, args => {
        if (/[\\/]brotli[\\/]dec[\\/]dictionary\.js$/.test(args.importer)) {
          return { path: path.join(root, 'node_modules/brotli/dec/dictionary-browser.js') };
        }
      });
      builder.onLoad({ filter: /[\\/]sources[\\/]aiyifan\.js$/ }, async args => {
        const text = await readFile(args.path, 'utf8');
        const signature = 'waitYearMap(promise, timeoutMs) {';
        // Optional website year enrichment must not break timerless hosts.
        const contents = text.replace(signature, signature + '\n    if (!globalThis.__LOGVAR_HAS_TIMERS__) { promise.catch(() => {}); return Promise.resolve(null); }');
        if (contents === text) throw new Error('Aiyifan year adapter no longer matches the core');
        return { contents, loader: 'js', resolveDir: path.dirname(args.path) };
      });
      builder.onLoad({ filter: /[\\/]sources[\\/]dandan\.js$/ }, async args => {
        // The optional TMDB task can reject after the original search already
        // returned. Consume that rejection within the Forward-only adapter.
        const text = await readFile(args.path, 'utf8');
        const contents = text.replace(/\}\)\(\);(\s*\/\/ 搜索结果预过滤)/,
          '})().catch(() => ({ success: false, source: "tmdb" }));$1');
        if (contents === text) throw new Error('Dandan fallback adapter no longer matches the core');
        return { contents, loader: 'js', resolveDir: path.dirname(args.path) };
      });
      builder.onLoad({ filter: /[\\/]http-util\.js$/ }, async args => {
        const text = await readFile(args.path, 'utf8');
        const contents = text
          .replace('export async function httpGet(', 'async function unusedNodeHttpGet(')
          .replace('export async function httpPost(', 'async function unusedNodeHttpPost(')
          .replace('export async function httpGetWithStreamCheck(', 'async function unusedNodeStreamGet(');
        const bridge = `
function normalizeHostResponse(response) {
  if (response && response.status === undefined && response.statusCode !== undefined) {
    response = { ...response, status: response.statusCode };
  }
  if (typeof response?.data === 'string') {
    try { return { ...response, data: JSON.parse(response.data) }; } catch (_) {}
  }
  return response;
}
export async function httpGet(url, options = {}) {
  return normalizeHostResponse(await Widget.http.get(url, { timeout: 15000, ...options }));
}
export async function httpPost(url, body, options = {}) {
  return normalizeHostResponse(await Widget.http.post(url, body, { timeout: 15000, ...options }));
}
export async function httpGetWithStreamCheck(url, options = {}, check) {
  const response = await httpGet(url, options);
  const text = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
  if (check && !check(text.slice(0, Number(options.sniffLimit) || 32768))) return null;
  return response.data;
}
`;
        return { contents: bridge + contents, loader: 'js', resolveDir: path.dirname(args.path) };
      });
    },
  }],
});

const externals = Object.values(result.metafile.outputs).flatMap(output => output.imports);
if (externals.length) throw new Error(`Bundle has runtime imports: ${JSON.stringify(externals)}`);
const banner = `var WidgetMetadata = ${JSON.stringify(metadata, null, 2)};\n// SPDX-License-Identifier: AGPL-3.0-only\n// Core based on huangxd-/danmu_api; adapted by maoxiaoc.\n`;
const footer = '\nfunction searchDanmu(params) { return LogvarForward.searchDanmu(params); }\nfunction getDetailById(params) { return LogvarForward.getDetailById(params); }\nfunction getCommentsById(params) { return LogvarForward.getCommentsById(params); }\n';
const output = banner + runtime + '\n' + result.outputFiles[0].text + footer;
const filename = `logvar-${target}-${metadata.version}.js`;
new vm.Script(output, { filename });
await mkdir(path.join(root, 'dist'), { recursive: true });
await writeFile(path.join(root, 'dist', filename), output);
console.log(`Built server/dist/${filename} (${(Buffer.byteLength(output) / 1024).toFixed(0)} KB), no runtime imports.`);
