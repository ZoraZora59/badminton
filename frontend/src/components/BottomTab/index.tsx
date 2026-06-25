import Taro from '@tarojs/taro';
import TabBar, { type TabKey } from '../TabBar';

export type { TabKey };

/**
 * 子页（push 页）用的底部常驻 tab：作为 PageFrame 的底部 flex 子元素（非 fixed）。
 * 视觉复用 TabBar；点击 switchTab 跳到对应根 tab 页。
 */
export default function BottomTab({ active }: { active: TabKey }) {
  return <TabBar active={active} onTab={(path) => Taro.switchTab({ url: path })} />;
}
