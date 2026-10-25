// Player-only adaptation shared by the current and 1.0.8 builders.
export function adaptTencentMethod(input) {
  let method = input;
  const pageAt = method.indexOf('// 获取页面标题');
  const segmentsAt = method.indexOf('// 获取弹幕分段数据', pageAt);
  if (pageAt < 0 || segmentsAt < 0) throw new Error('Tencent HTML adapter no longer matches core');
  method = method.slice(0, pageAt) + method.slice(segmentsAt);
  const replace = (before, after) => {
    if (!method.includes(before)) throw new Error('Tencent timing adapter no longer matches core: ' + before);
    method = method.replace(before, after);
  };
  replace('let vid = this.extractVid(id);', `let vid = this.extractVid(id);
    const tencentStarted = Date.now();
    console.log('[LogVar耗时] ' + JSON.stringify({phase:'tencent-start',elapsedMs:0}));`);
  replace('const segmentResult = await this.getEpisodeDanmuSegments(id);', `const segmentResult = await this.getEpisodeDanmuSegments(id);
    console.log('[LogVar耗时] ' + JSON.stringify({phase:'tencent-index',elapsedMs:Date.now()-tencentStarted,total:segmentResult?.segmentList?.length||0}));`);
  replace('const promises = [];', `const promises = [];
    const downloadStarted = Date.now();
    let completed = 0, failed = 0;
    const progress = error => {
      completed++;
      if (error) failed++;
      if (error || completed === 1 || completed % 10 === 0 || completed === segmentList.length)
        console.log('[LogVar耗时] ' + JSON.stringify({phase:'tencent-download',elapsedMs:Date.now()-downloadStarted,completed,total:segmentList.length,failed}));
    };`);
  const requestEnd = /retries: 1,\s*\}\)/;
  if (!requestEnd.test(method)) throw new Error('Tencent request adapter no longer matches core');
  method = method.replace(requestEnd, '$&.then(response => { progress(false); return response; }, error => { progress(true); throw error; })');
  replace('printFirst200Chars(contents);', `console.log('[LogVar耗时] ' + JSON.stringify({phase:'tencent-data',elapsedMs:Date.now()-tencentStarted,rawCount:contents.length}));
    printFirst200Chars(contents);`);
  return method;
}
