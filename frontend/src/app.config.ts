export default defineAppConfig({
  pages: [
    'pages/home/index',
    'pages/profile/index',
    'pages/me/index',
    'pages/create/index',
    'pages/activity/index',
    'pages/checkin/index',
    'pages/grouping/index',
    'pages/board/index',
    'pages/scoring/index',
    'pages/summary/index',
    // 只读战绩详情：与「战绩」tab 同一个组件，但挂非 tabBar 路由，
    // 这样球局里点头像能 navigateTo 过去并正常返回（tabBar 页不允许 navigateTo）
    'pages/player/index',
  ],
  window: {
    navigationBarTitleText: '羽毛球小助手',
    navigationBarBackgroundColor: '#16A34A',
    navigationBarTextStyle: 'white',
    backgroundColor: '#F5F8F4',
    backgroundTextStyle: 'dark',
  },
  tabBar: {
    // 自定义 tabBar：选中态药丸底等高保真样式由 src/custom-tab-bar 渲染，原生 tabBar 做不到
    custom: true,
    color: '#a4a9af',
    selectedColor: '#16A34A',
    backgroundColor: '#ffffff',
    borderStyle: 'white',
    list: [
      { pagePath: 'pages/home/index', text: '球局' },
      { pagePath: 'pages/profile/index', text: '战绩' },
      { pagePath: 'pages/me/index', text: '我的' },
    ],
  },
});
