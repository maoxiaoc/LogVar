import assert from 'node:assert/strict';
import { withStage, widgetRequest, markSearchDetails, canWriteDetails, collectStage } from './stages.js';

const originalNow = Date.now;
const originalFlag = globalThis.__LOGVAR_HAS_TIMERS__;
globalThis.__LOGVAR_HAS_TIMERS__ = false;
try {
  let now = 0, requests = 0;
  Date.now = () => now;
  await assert.rejects(withStage('search', async () => {
    const details = markSearchDetails(new Map(), 'dandan');
    await widgetRequest(() => { requests++; now = 30001; return {}; });
    assert.equal(canWriteDetails(details), false, 'Expired stages must reject detail writes without a timer');
    return widgetRequest(() => { requests++; return {}; });
  }, []), /等待已结束/);
  assert.equal(requests, 1, 'No retry or following request after the shared budget');

  now = 0;
  requests = 0;
  await assert.rejects(withStage('comments', async () => {
    const queued = widgetRequest(() => { requests++; return {}; });
    now = 30001;
    return queued;
  }, []), /等待已结束/);
  assert.equal(requests, 0, 'Recheck the budget immediately before crossing the host bridge');

  // With no clock callback, an HTTP completion after the grace deadline must
  // release completed sources rather than wait for the entire slow pipeline.
  now = 0;
  requests = 0;
  let first, later;
  const firstResult = new Promise(resolve => { first = resolve; });
  const lateResponse = new Promise(resolve => { later = resolve; });
  const collecting = withStage('comments', () => collectStage([
    { key: 'tencent', promise: firstResult },
    { key: 'dandan', promise: (async () => {
      await widgetRequest(() => { requests++; return lateResponse; });
      await widgetRequest(() => { requests++; return {}; });
      return {comments:[2]};
    })() },
  ], (_, result) => result.comments.length > 0), []);
  now = 1000;
  first({comments:[1]});
  for (let i=0;i<5;i++) await Promise.resolve();
  now = 12000;
  later({});
  const settled = await collecting;
  assert.equal(settled[0].status,'fulfilled');
  assert.equal(settled[1].status,'rejected');
  assert.equal(requests,1,'Native completion after the window must not start another fallback');
} finally {
  Date.now = originalNow;
  if (originalFlag === undefined) delete globalThis.__LOGVAR_HAS_TIMERS__;
  else globalThis.__LOGVAR_HAS_TIMERS__ = originalFlag;
}
console.log('Timerless checkpoints passed: no late detail writes, no new requests/retries after budget, queued sends rechecked. Pending native requests still require host support.');
