const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const appRoot = process.argv[2];
process.chdir(appRoot);
const configDir = path.join(appRoot, 'config');
const cacheDir = path.join(appRoot, '.cache');
fs.mkdirSync(configDir, { recursive: true });
fs.mkdirSync(cacheDir, { recursive: true });
const envPath = path.join(configDir, '.env');
if (!fs.existsSync(envPath)) {
  const token = crypto.randomBytes(16).toString('hex');
  const admin = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(envPath, [
    `TOKEN=${token}`, `ADMIN_TOKEN=${admin}`,
    'SOURCE_ORDER=tencent,iqiyi,bilibili,dandan,imgo,youku,renren,hanjutv',
    'PLATFORM_ORDER=qq,qiyi,bilibili1,dandan,imgo,youku,renren,hanjutv',
    'MERGE_SOURCE_PAIRS=tencent&iqiyi&bilibili&dandan&imgo&youku&renren&hanjutv',
    'SEARCH_CACHE_MINUTES=10', 'COMMENT_CACHE_MINUTES=30', 'RATE_LIMIT_MAX_REQUESTS=30'
  ].join('\n'));
}
(async () => {
  await import(require('url').pathToFileURL(path.join(appRoot, 'danmu_api', 'server.js')).href);
  const controlPath = path.join(appRoot, 'control.json');
  if (!fs.existsSync(controlPath)) fs.writeFileSync(controlPath, JSON.stringify({ running: true }));
  let wanted = true;
  setInterval(async () => {
    try {
      const next = JSON.parse(fs.readFileSync(controlPath, 'utf8')).running !== false;
      if (next === wanted) return;
      wanted = next;
      if (wanted) await globalThis.logvarStartServer();
      else await globalThis.logvarStopServer();
    } catch (error) { console.error('[Logvar] Control update failed:', error.message); }
  }, 500);
})();
