export async function collectSearchTasks(tasks, scope, { graceMs = 5000, totalMs = 30000 } = {}) {
  // Widget has its own host-aware stage timer; do not start a second timer there.
  if (globalThis.__FORWARD_WIDGET__ === true) {
    const results = await Promise.allSettled(tasks.map(task => task.promise));
    scope.closed = true;
    return { results, partial: false };
  }
  const results = tasks.map(() => ({ status: 'rejected', reason: new Error('来源等待超时') }));
  let finished = 0, ready = false, ended = false, partial = false, timer;
  return new Promise(resolve => {
    const finish = timedOut => {
      if (ended) return;
      ended = true; partial = timedOut && finished < tasks.length; scope.closed = true;
      clearTimeout(timer); resolve({ results, partial });
    };
    timer = setTimeout(() => finish(true), totalMs);
    if (!tasks.length) return finish(false);
    tasks.forEach((task, i) => Promise.resolve(task.promise).then(value => {
      if (ended) return;
      results[i] = { status: 'fulfilled', value }; finished++;
      if (!ready && task.animes.some(a => Number(a.episodeCount) > 0) && task.detailStore.size > 0) {
        ready = true; clearTimeout(timer); timer = setTimeout(() => finish(true), Math.min(graceMs, Math.max(0, totalMs - (Date.now() - scope.startedAt))));
      }
      if (finished === tasks.length) finish(false);
    }, reason => { if (ended) return; results[i] = { status: 'rejected', reason }; if (++finished === tasks.length) finish(false); }));
  });
}
