import { Envs } from '../configs/envs.js';

const aliases = { qq: 'tencent', qiyi: 'iqiyi', bilibili1: 'bilibili', '韩小圈': 'hanjutv', '极速版': 'hanjutv' };
const known = new Set([...Envs.MERGE_ALLOWED_SOURCES, ...Object.keys(aliases)]);

// /match has one selected episode. Only label sources present in its returned comments.
export async function annotateMatchSources(response, loadComments, timeoutMs = 3000) {
  if (!response.ok) return response;
  const data = await response.json();
  if (!data.isMatched || !Array.isArray(data.matches) || !data.matches.length) return new Response(JSON.stringify(data), { status: response.status, headers: response.headers });
  const match = data.matches[0];
  let timer;
  try {
    const comments = await Promise.race([
      Promise.resolve().then(() => loadComments(match.episodeId)),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); })
    ]);
    const actual = new Set();
    if (Array.isArray(comments)) for (const comment of comments) {
      if (!comment || typeof comment.m !== 'string' || !comment.m.trim()) continue;
      const marker = String(comment.p || '').split(',')[3]?.match(/^\[([^\]]+)\]$/)?.[1];
      for (const source of (marker || '').split(/[&＆]/)) {
        const key = aliases[source] || source;
        if (known.has(source) && Envs.MERGE_ALLOWED_SOURCES.includes(key)) actual.add(key);
      }
    }
    const candidates = (match.episodeTitle || '').match(/^【([^】]+)】/)?.[1]?.split(/[&＆]/).map(s => aliases[s.trim()] || s.trim()) || [];
    const names = [...new Set([...candidates.filter(s => actual.has(s)), ...actual])].join('&');
    const suffix = /\s*from\s+[a-zA-Z0-9&＆]+\s*$/;
    match.animeTitle = String(match.animeTitle || '').replace(suffix, names ? ` from ${names}` : '');
    match.episodeTitle = String(match.episodeTitle || '').replace(/^【[^】]+】\s*/, names ? `【${names}】 ` : '');
  } catch {
    match.animeTitle = String(match.animeTitle || '').replace(/\s*from\s+[a-zA-Z0-9&＆]+\s*$/, '');
    match.episodeTitle = String(match.episodeTitle || '').replace(/^【[^】]+】\s*/, '');
  } finally { clearTimeout(timer); }
  return new Response(JSON.stringify(data), { status: response.status, headers: response.headers });
}
