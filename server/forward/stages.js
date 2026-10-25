// SPDX-License-Identifier: AGPL-3.0-only
// One module instance belongs to one callback; a closed instance is never reused.
export const LIMITS = Object.freeze({ search: 5000, comments: 10000, total: 30000, request: 15000 });
let active;
const expired = () => new Error('本轮来源等待已结束。');
const timers = () => globalThis.__LOGVAR_HAS_TIMERS__;
const stageExpired = stage => stage && (stage.closed || Date.now() >= stage.deadline);

export function logTiming(phase, startedAt, detail = {}) {
  console.log('[LogVar耗时] ' + JSON.stringify({ phase, elapsedMs: Date.now() - startedAt, ...detail }));
}

export function markSearchDetails(store, source) {
  if (active) store.__widgetScope = { stage: active, source };
  return store;
}

export function canWriteDetails(store) {
  const scope = store?.__widgetScope;
  return !scope || !stageExpired(scope.stage);
}

export function widgetRequest(send, options = {}, key) {
  const stage = active;
  if (stageExpired(stage)) return Promise.reject(expired());
  if (key && stage?.inflight.has(key)) return stage.inflight.get(key);
  const timeout = Math.min(LIMITS.request, Number(options.timeout) || LIMITS.request,
    stage ? Math.max(1, stage.deadline - Date.now()) : LIMITS.request);
  const sendChecked = () => {
    // A timerless host can only check time at these boundaries. This stops
    // later retries/segments; it cannot interrupt a native request in flight.
    if (stageExpired(stage)) throw expired();
    return send({ ...options, timeout });
  };
  const request = !timers() ? Promise.resolve().then(sendChecked) : new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stage?.requests.delete(cancel);
      fn(value);
    };
    const cancel = () => finish(reject, expired());
    const timer = setTimeout(cancel, timeout);
    stage?.requests.add(cancel);
    // Attach rejection handlers even when the host cannot physically cancel HTTP.
    Promise.resolve().then(() => {
      if (done || stage?.closed) throw expired();
      return sendChecked();
    }).then(value => finish(resolve, value), error => finish(reject, error));
  });
  // A native completion is a chance to enforce a soft deadline even without
  // timers. Never create a synthetic clock through extra HTTP requests.
  const checkpoint = () => stage?.checkpoint?.();
  request.then(checkpoint, checkpoint);
  if (key && stage) {
    stage.inflight.set(key, request);
    const remove = () => stage.inflight.delete(key);
    request.then(remove, remove);
  }
  return request;
}

function close(stage) {
  if (stage.closed) return;
  stage.closed = true;
  for (const cancel of [...stage.requests]) cancel();
}

export async function withStage(kind, operation, empty) {
  const startedAt = Date.now();
  const stage = { kind, startedAt, deadline: startedAt + LIMITS.total, requests: new Set(), inflight: new Map(), closed: false };
  active = stage;
  if (!timers()) {
    console.warn('[LogVar] 宿主无计时器；仅在请求返回时检查预算，在途请求由播放器结束，不能保证5秒/10秒窗口或30秒上限。');
    try { return await operation(); } finally { close(stage); logTiming(kind, startedAt, { timers: false }); }
  }
  let timer;
  const deadline = new Promise(resolve => {
    timer = setTimeout(() => {
      if (stage.collector) stage.collector();
      else { close(stage); resolve(empty); }
    }, LIMITS.total);
  });
  try { return await Promise.race([Promise.resolve().then(operation), deadline]); }
  finally { clearTimeout(timer); close(stage); logTiming(kind, startedAt, { timers: true }); }
}

export function collectStage(tasks, ready) {
  const stage = active;
  if (!stage) return Promise.allSettled(tasks.map(task => task.promise));
  return new Promise(resolve => {
    const results = tasks.map(() => ({ status: 'rejected', reason: expired() }));
    const completed = new Set();
    let ended = false, timer, firstReady = false;
    const logged = new Set();
    const record = (i, result, value) => {
      if (logged.has(i)) return;
      logged.add(i);
      logTiming('source', tasks[i].startedAt ?? stage.startedAt, {
        stage: stage.kind, source: String(tasks[i].key || '').split(':')[0], result,
        count: value?.comments?.length ?? tasks[i].animes?.length ?? null,
      });
    };
    const finish = (stop = true) => {
      if (ended) return;
      ended = true;
      if (timers()) clearTimeout(timer);
      tasks.forEach((_, i) => { if (!completed.has(i)) record(i, '截至返回仍未完成，已舍弃'); });
      // Empty metadata results may fall back to the original title within the
      // same budget. Only leave the stage open if every task already settled.
      if (stop) close(stage);
      stage.collector = undefined;
      stage.checkpoint = undefined;
      resolve(results);
    };
    stage.collector = finish;
    stage.checkpoint = () => { if (stageExpired(stage)) finish(); };
    if (timers()) timer = setTimeout(finish, Math.max(0, stage.deadline - Date.now()));
    if (stage.closed || !tasks.length) { finish(stage.closed); return; }
    tasks.forEach((task, i) => {
      Promise.resolve(task.promise).then(value => {
        if (ended) return;
        if (stageExpired(stage)) { finish(); return; }
        results[i] = { status: 'fulfilled', value };
        completed.add(i);
        const valid = ready(task, value);
        record(i, value?.failed ? '获取失败' : valid ? '有效结果' : '无有效结果', value);
        if (!firstReady && valid) {
          firstReady = true;
          stage.deadline = Math.min(stage.deadline, Date.now() + LIMITS[stage.kind]);
          if (timers()) {
            clearTimeout(timer);
            timer = setTimeout(finish, Math.max(0, stage.deadline - Date.now()));
          }
        }
        if (completed.size === tasks.length) finish(firstReady);
      }, reason => {
        if (ended) return;
        if (stageExpired(stage)) { finish(); return; }
        results[i] = { status: 'rejected', reason };
        completed.add(i);
        record(i, '失败');
        if (completed.size === tasks.length) finish(firstReady);
      });
    });
  });
}

export const collectSearch = tasks => collectStage(tasks, task =>
  task.animes?.some(anime => Number(anime.episodeCount) > 0) && task.detailStore?.size > 0);
