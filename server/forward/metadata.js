const version = '1.0.18';

export default {
  id: 'logvar.danmu',
  title: 'LogVar',
  version,
  requiredVersion: '0.0.2',
  detailCacheDuration: 0,
  description: '在播放器内直接获取弹幕：合并全部来源，或仅保留弹幕最多的来源。',
  author: 'maoxiaoc',
  site: 'https://github.com/maoxiaoc/LogVar',
  globalParams: [
    {
      name: 'sourceMode', title: '弹幕处理方式', type: 'enumeration', value: 'mergeAll',
      enumOptions: [
        { title: '合并全部来源', value: 'mergeAll' },
        { title: '仅保留弹幕最多的来源', value: 'most' },
      ],
    },
    {
      name: 'enabledSources', title: '启用来源（未设置时使用默认来源）', type: 'input',
      value: 'tencent,iqiyi,imgo,bilibili,youku,dandan,renren,hanjutv',
      description: '填写时用逗号分隔；填写内容会替换默认列表；腾讯=tencent，爱奇艺=iqiyi，芒果=imgo，B站=bilibili，优酷=youku，弹弹play=dandan，人人=renren，韩剧TV=hanjutv',
    },
    { name: 'bilibiliCookie', title: 'B站 Cookie（可选）', type: 'input' },
    { name: 'blockedWords', title: '屏蔽词（可选，沿用 LogVar 规则）', type: 'input' },
    { name: 'groupMinute', title: '相同内容去重间隔（分钟，0 为精确时间去重）', type: 'input', value: '1',
      description: '填写 0～30 的数字，未填写时为 1。' },
  ],
  modules: [
    { id: 'searchDanmu', title: '搜索弹幕', functionName: 'searchDanmu', type: 'danmu', params: [], cacheDuration: 0 },
    { id: 'getDetail', title: '选择分集', functionName: 'getDetailById', type: 'danmu', params: [], cacheDuration: 0 },
    { id: 'getComments', title: '加载弹幕', functionName: 'getCommentsById', type: 'danmu', params: [], cacheDuration: 0 },
    { id: 'clearDanmuCache', title: '清理弹幕缓存', functionName: 'clearDanmuCache', params: [], cacheDuration: 0 },
  ],
};
