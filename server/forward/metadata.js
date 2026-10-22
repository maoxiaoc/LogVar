const version = '1.0.3';

export default {
  id: 'logvar.forward.local',
  title: 'LogVar',
  version,
  requiredVersion: '0.0.2',
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
      name: 'enabledSources', title: '启用来源（逗号分隔，不分优先级）', type: 'input',
      value: 'tencent,iqiyi,imgo,bilibili,youku,dandan,renren,hanjutv',
      description: '腾讯=tencent，爱奇艺=iqiyi，芒果=imgo，B站=bilibili，优酷=youku，弹弹play=dandan，人人=renren，韩剧TV=hanjutv；还支持 migu,sohu,leshi,xigua,maiduidui,aiyifan,hongguo,bahamut,animeko。',
    },
    { name: 'bilibiliCookie', title: 'B站 Cookie（可选）', type: 'input' },
    { name: 'blockedWords', title: '屏蔽词（可选，沿用 LogVar 规则）', type: 'input' },
    { name: 'groupMinute', title: '相同内容去重间隔（分钟，0 为精确时间去重）', type: 'count', value: '1' },
  ],
  modules: [
    { id: 'searchDanmu', title: '搜索弹幕', functionName: 'searchDanmu', type: 'danmu', params: [], cacheDuration: 0 },
    { id: 'getDetail', title: '选择分集', functionName: 'getDetailById', type: 'danmu', params: [], cacheDuration: 0 },
    { id: 'getComments', title: '加载弹幕', functionName: 'getCommentsById', type: 'danmu', params: [], cacheDuration: 0 },
  ],
};
