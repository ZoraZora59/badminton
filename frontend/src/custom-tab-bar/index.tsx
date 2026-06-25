import { useState } from 'react';
import Taro, { useDidShow } from '@tarojs/taro';
import TabBar, { TAB_LIST, type TabKey } from '../components/TabBar';
import './index.scss';

/** 由当前页面路由推导高亮的 tab（每个 tab 页各有一份 custom-tab-bar 实例，按自身路由解析即正确） */
function resolveActive(): TabKey {
  const pages = Taro.getCurrentPages();
  const route = pages.length ? pages[pages.length - 1].route ?? '' : '';
  const hit = TAB_LIST.find((t) => t.path === `/${route}`);
  return hit ? hit.key : 'home';
}

/**
 * 微信自定义 tabBar（app.config tabBar.custom=true 时由框架渲染在底部图层）。
 * 用 TabBar 渲染药丸选中态；高亮由路由推导，switchTab 切页后目标页的实例自行解析。
 */
export default function CustomTabBar() {
  const [active, setActive] = useState<TabKey>(resolveActive);
  // 通过 switchTab 落到本 tab 页时同步一次高亮（首次挂载已由 useState 初值兜底）
  useDidShow(() => setActive(resolveActive()));
  return <TabBar fixed active={active} onTab={(path) => Taro.switchTab({ url: path })} />;
}
