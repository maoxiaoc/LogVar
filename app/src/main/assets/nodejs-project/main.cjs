const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const appRoot = process.argv[2];
process.chdir(appRoot);
process.env.LOGVAR_ANDROID = '1';
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
    'SOURCE_ORDER=tencent,iqiyi,bilibili,dandan,imgo,youku,renren,hanjutv,aiyifan',
    'PLATFORM_ORDER=qq,qiyi,bilibili1,dandan,imgo,youku,renren,hanjutv,aiyifan',
    'MERGE_SOURCE_PAIRS=tencent&iqiyi&bilibili&dandan&imgo&youku&renren&hanjutv&aiyifan',
    'SEARCH_CACHE_MINUTES=10', 'COMMENT_CACHE_MINUTES=30', 'RATE_LIMIT_MAX_REQUESTS=30'
  ].join('\n'));
}
(async () => {
  await import(require('url').pathToFileURL(path.join(appRoot, 'danmu_api', 'server.js')).href);
})().catch(error => { console.error('[Logvar] Startup failed:', error); process.exit(1); });
