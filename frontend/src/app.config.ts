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
  ],
  window: {
    navigationBarTitleText: '来打我呀',
    navigationBarBackgroundColor: '#16A34A',
    navigationBarTextStyle: 'white',
    backgroundColor: '#F5F8F4',
    backgroundTextStyle: 'dark',
  },
  tabBar: {
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
