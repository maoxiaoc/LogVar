import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import metadata from './metadata.js';
import { adaptTencentMethod } from './tencent-adapter.mjs';

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
        let contents = text.replace(/\}\)\(\);(\s*\/\/ 搜索结果预过滤)/,
          '})().catch(() => ({ success: false, source: "tmdb" }));$1');
        if (contents === text) throw new Error('Dandan fallback adapter no longer matches the core');
        // Search fallback/season expansion can revisit the same work. Keep
        // successful details only within this private callback runtime.
        contents += `
const widgetDandanDetails = new Map();
const originalDandanDetails = DandanSource.prototype.getEpisodes;
DandanSource.prototype.getEpisodes = async function(id) {
  const key = String(id);
  if (widgetDandanDetails.has(key)) return widgetDandanDetails.get(key);
  const result = await originalDandanDetails.call(this, id);
  if (result?.episodes?.length) {
    widgetDandanDetails.set(key, result);
    if (widgetDandanDetails.size > 16) widgetDandanDetails.delete(widgetDandanDetails.keys().next().value);
  }
  return result;
};
`;
        return { contents, loader: 'js', resolveDir: path.dirname(args.path) };
      });
      builder.onLoad({ filter: /[\\/]sources[\\/](?:tencent|mango|iqiyi|youku|bilibili)\.js$/ }, async args => {
        const text = await readFile(args.path, 'utf8');
        const start = text.indexOf('async getEpisodeDanmu(id)');
        const end = text.indexOf('async getEpisodeDanmuSegments(id)', start);
        if (start < 0 || end < 0) throw new Error('Full-episode adapter no longer matches core: ' + args.path);
        let method = text.slice(start, end)
          .replace(/const (results|settled) = await Promise\.allSettled\((promises|batch)\);/g,
            '$&\nif ($1.some(item => item.status === "rejected")) return [];')
          .replace('if (res.error?.bilibiliCode !== undefined) throw res.error;', 'throw res.error || new Error("弹幕分片未完成");');
        let contents = text.slice(0, start) + method + text.slice(end);
        if (path.basename(args.path) === 'tencent.js') {
          method = adaptTencentMethod(method);
          contents = text.slice(0, start) + method + text.slice(end);
        }
        // IQIYI's segment helper swallowed transport/decode failures as empty
        // segments. Preserve legitimate 404/empty responses, reject failures.
        if (path.basename(args.path) === 'iqiyi.js') {
          const signature = 'async getEpisodeSegmentDanmu(segment)';
          const at = contents.indexOf(signature);
          const head = contents.slice(0, at), tail = contents.slice(at);
          const patched = tail.replace('return []; // 返回空数组而不是抛出错误，保持与getEpisodeDanmu一致的行为', 'throw error;');
          if (at < 0 || patched === tail) throw new Error('IQIYI segment adapter no longer matches core');
          contents = head + patched;
            // Native players may have no timers. Try one alternate official route
            // instead of entering the core's delayed retry loop in that host.
            const replaceIqiyi = (before, after) => {
              if (!contents.includes(before)) throw new Error('IQIYI retry adapter no longer matches core: ' + before);
              contents = contents.replace(before, after);
            };
            replaceIqiyi('const doSearch = async (bypassCache = false) => {', 'const doSearch = async (bypassCache = false, requestUrl = url) => {');
            replaceIqiyi('const resp = await httpGet(url, {', 'const resp = await httpGet(requestUrl, {');
            replaceIqiyi('const MAX_RETRIES = 2;', 'const MAX_RETRIES = globalThis.__LOGVAR_HAS_TIMERS__ ? 2 : 0;');
            replaceIqiyi('let data = await doSearch();', `let data = await doSearch();
      if (!globalThis.__LOGVAR_HAS_TIMERS__ && (!data || String(data.code) === "-1")) {
        log("info", "[iqiyi] 搜索主接口异常，无计时器环境改用备用接口一次");
        data = await doSearch(true, url.replace("https://mesh.if.iqiyi.com/", "https://www.iqiyi.com/prelw/"));
      }`);
            contents = contents.replaceAll('data.code === "-1"', 'String(data.code) === "-1"');
            replaceIqiyi('const MAX_EPISODE_RETRIES = 2;', 'const MAX_EPISODE_RETRIES = globalThis.__LOGVAR_HAS_TIMERS__ ? 2 : 0;');
            replaceIqiyi('const fetchEpisodeData = async (bypassCache = false) => {', 'const fetchEpisodeData = async (bypassCache = false, requestUrl = url) => {');
            // Scope to the base-info helper; other source requests keep their URL.
            const baseAt = contents.indexOf('async _fetchBaseInfoData(entityId)');
            const baseTail = contents.slice(baseAt);
            const basePatched = baseTail.replace('const resp = await httpGet(url, {', 'const resp = await httpGet(requestUrl, {');
            if (basePatched === baseTail) throw new Error('IQIYI base-info URL adapter no longer matches core');
            contents = contents.slice(0, baseAt) + basePatched;
            replaceIqiyi('let data = await fetchEpisodeData();', `let data = await fetchEpisodeData();
    if (!globalThis.__LOGVAR_HAS_TIMERS__ && (!data || data.status_code !== 0 || !data.data || !data.data.template)) {
      log("info", "[iqiyi] 分集主接口异常，无计时器环境改用备用接口一次");
      data = await fetchEpisodeData(true, url.replace("https://www.iqiyi.com/prelw/", "https://mesh.if.iqiyi.com/"));
    }`);
        }
        if (contents === text) throw new Error('Segment completeness adapter no longer matches core: ' + args.path);
        return { contents, loader: 'js', resolveDir: path.dirname(args.path) };
      });
      builder.onLoad({ filter: /[\\/]apis[\\/]dandan-api\.js$/ }, async args => {
        const text = await readFile(args.path, 'utf8');
        const contents = text
          .replace('const isolatedDetailStore = new Map();', 'const isolatedDetailStore = markSearchDetails(new Map(), key);')
          .replace('const sourceSearchMap = {};', 'const sourceSearchMap = {}; const sourceStartedAt = {};')
          .replace('const args = meta.extraSearchArgs', 'sourceStartedAt[source] = Date.now(); const args = meta.extraSearchArgs')
          .replace('return { key: source, animes: isolatedAnimes', 'return { key: source, startedAt: sourceStartedAt[source], animes: isolatedAnimes')
          .replace('await collectSearchTasks(pipelineTasks, searchScope)', "await collectSearch(pipelineTasks).then(results => { searchScope.closed = true; return { results, partial: results.some(item => item.status === 'rejected') }; })");
        if (contents === text || !contents.includes('await collectSearch(pipelineTasks)')) throw new Error('Search stage adapter no longer matches core');
        return { contents: `import { collectSearch, markSearchDetails } from ${JSON.stringify(path.join(root, 'forward/stages.js'))};\n` + contents,
          loader: 'js', resolveDir: path.dirname(args.path) };
      });
      builder.onLoad({ filter: /[\\/]cache-util\.js$/ }, async args => {
        const text = await readFile(args.path, 'utf8');
        const contents = text.replace('export function addAnime(anime, detailStore = null) {',
          'export function addAnime(anime, detailStore = null) {\n    if (!canWriteDetails(detailStore)) return false;');
        if (contents === text) throw new Error('Cache stage adapter no longer matches core');
        return { contents: `import { canWriteDetails } from ${JSON.stringify(path.join(root, 'forward/stages.js'))};\n` + contents,
          loader: 'js', resolveDir: path.dirname(args.path) };
      });
      builder.onLoad({ filter: /[\\/]http-util\.js$/ }, async args => {
        const text = await readFile(args.path, 'utf8');
        const contents = text
          .replace('export async function httpGet(', 'async function unusedNodeHttpGet(')
          .replace('export async function httpPost(', 'async function unusedNodeHttpPost(')
          .replace('export async function httpGetWithStreamCheck(', 'async function unusedNodeStreamGet(');
        const bridge = `import { widgetRequest } from ${JSON.stringify(path.join(root, 'forward/stages.js'))};
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
  return normalizeHostResponse(await widgetRequest(opts => Widget.http.get(url, opts), options, JSON.stringify(['GET', url, options])));
}
export async function httpPost(url, body, options = {}) {
  return normalizeHostResponse(await widgetRequest(opts => Widget.http.post(url, body, opts), options));
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
// Each callback gets a private core. Detached host HTTP responses can only
// touch that old core, never a new search's mutable globals or source instances.
const footer = `
var currentLogvar = createLogvarRuntime();
var LogvarForward = {};
for (const key of Object.keys(currentLogvar)) {
  LogvarForward[key] = (...args) => currentLogvar[key](...args);
}
var logvarPending = Promise.resolve();
var logvarInflight = new Map();
function logvarCallback(name, params) {
  const key = JSON.stringify([name, Object.entries(params || {}).sort(([a], [b]) => a.localeCompare(b))]);
  if (logvarInflight.has(key)) return logvarInflight.get(key);
  const queuedAt = Date.now();
  const task = logvarPending.then(async () => {
    const startedAt = Date.now();
    console.log('[LogVar耗时] ' + JSON.stringify({ phase: 'callback-start', callback: name, queueMs: startedAt - queuedAt }));
    currentLogvar = createLogvarRuntime();
    try {
      const value = await currentLogvar[name](params);
      console.log('[LogVar耗时] ' + JSON.stringify({ phase: 'callback-return', callback: name,
        elapsedMs: Date.now() - startedAt, shape: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value,
        count: value?.count ?? value?.animes?.length ?? (Array.isArray(value) ? value.length : null) }));
      return value;
    } catch (error) {
      console.log('[LogVar耗时] ' + JSON.stringify({ phase: 'callback-error', callback: name, elapsedMs: Date.now() - startedAt }));
      throw error;
    }
  });
  logvarInflight.set(key, task);
  const remove = () => logvarInflight.delete(key);
  task.then(remove, remove);
  logvarPending = task.catch(() => {});
  return task;
}
function searchDanmu(params) { return logvarCallback('searchDanmu', params); }
function getDetailById(params) { return logvarCallback('getDetailById', params); }
function getCommentsById(params) { return logvarCallback('getCommentsById', params); }
function clearDanmuCache(params) { return logvarCallback('clearDanmuCache', params); }
`;
const output = (banner + runtime + '\nfunction createLogvarRuntime() {\n' + result.outputFiles[0].text + '\nreturn LogvarForward;\n}\n' + footer).replace(/[ \t]+$/gm, '');
const filename = `logvar-${metadata.version}.js`;
new vm.Script(output, { filename });
await mkdir(path.join(root, 'dist'), { recursive: true });
await writeFile(path.join(root, 'dist', filename), output);
console.log(`Built server/dist/${filename} (${(Buffer.byteLength(output) / 1024).toFixed(0)} KB), no runtime imports.`);
