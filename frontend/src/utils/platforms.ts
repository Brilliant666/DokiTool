/** Public platform choices match the nine parsers registered by the PHP gateway. */
export const supportedPlatforms = [
  { key: 'douyin', name: '抖音', english: 'Douyin', icon: 'fa-music', url: 'https://www.douyin.com', color: '#fe2c55' },
  { key: 'kuaishou', name: '快手', english: 'Kuaishou', icon: 'fa-bolt', url: 'https://www.kuaishou.com', color: '#ff4906' },
  { key: 'bilibili', name: 'B站', english: 'Bilibili', icon: 'fa-play-circle', url: 'https://www.bilibili.com', color: '#00a1d6' },
  { key: 'xhs', name: '小红书', english: 'Xiaohongshu', icon: 'fa-bookmark', url: 'https://www.xiaohongshu.com', color: '#fe2c55' },
  { key: 'toutiao', name: '今日头条', english: 'Toutiao', icon: 'fa-newspaper', url: 'https://www.toutiao.com', color: '#e6162d' },
  { key: 'weibo', name: '微博', english: 'Weibo', icon: 'fa-comment', url: 'https://weibo.com', color: '#e6162d' },
  { key: 'pipixia', name: '皮皮虾', english: 'Pipixia', icon: 'fa-face-laugh', url: 'https://www.pipix.com', color: '#c99100' },
  { key: 'pipigx', name: '皮皮搞笑', english: 'Pipigx', icon: 'fa-face-smile', url: 'https://www.pipigx.com', color: '#25a878' },
  { key: 'zuiyou', name: '最右', english: 'Zuiyou', icon: 'fa-comments', url: 'https://www.izuiyou.com', color: '#8854d0' },
];

export function platformTabs(locale: string) {
  return [
    { key: 'all', label: locale === 'en' ? 'All' : '所有平台', icon: 'fa-globe' },
    ...supportedPlatforms.map((platform) => ({
      key: platform.key,
      label: locale === 'en' ? platform.english : platform.name,
      icon: platform.icon,
    })),
  ];
}
