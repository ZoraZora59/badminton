// 微信自定义 tabBar 必须声明为组件，否则会被当作页面、底栏不渲染。
// Taro 仅在存在本配置时才为 custom-tab-bar 生成 json，这里显式标记 component。
export default {
  component: true,
};
