import { View, Text } from '@tarojs/components';
import Icon, { type IconName } from '../Icon';
import './index.scss';

/** tab 页 key，与 app.config tabBar.list 一一对应 */
export type TabKey = 'home' | 'profile' | 'me';

/** 三个根 tab 的唯一配置源：图标 + 文案 + switchTab 路径 */
export const TAB_LIST: { key: TabKey; text: string; icon: IconName; path: string }[] = [
  { key: 'home', text: '球局', icon: 'grid', path: '/pages/home/index' },
  { key: 'profile', text: '战绩', icon: 'trophy', path: '/pages/profile/index' },
  { key: 'me', text: '我的', icon: 'user', path: '/pages/me/index' },
];

const ACTIVE = '#16a34a';
const INACTIVE = '#9aa0a6';

interface Props {
  /** 当前高亮 tab */
  active: TabKey;
  /** 点击某个 tab：传入其 switchTab 路径 */
  onTab: (path: string) => void;
  /** 是否固定在视口底部（自定义 tabBar 用 true；PageFrame 内联用 false） */
  fixed?: boolean;
}

/**
 * 底部 tab 视觉单元（对齐高保真稿）：选中态 = 绿色图标 + 绿标签 + 浅绿药丸底；
 * 未选 = 线性灰图标 + 灰标签。被 custom-tab-bar（根页）与 BottomTab（子页）共用，保证全站一致。
 */
export default function TabBar({ active, onTab, fixed }: Props) {
  return (
    <View className={`tbar ${fixed ? 'tbar--fixed' : ''}`}>
      <View className="tbar__row">
        {TAB_LIST.map((t) => {
          const on = t.key === active;
          return (
            <View key={t.key} className="tbar__item" onClick={() => onTab(t.path)}>
              <View className={`tbar__pill ${on ? 'tbar__pill--on' : ''}`}>
                <Icon name={t.icon} size={22} color={on ? ACTIVE : INACTIVE} />
              </View>
              <Text className={`tbar__txt ${on ? 'tbar__txt--on' : ''}`}>{t.text}</Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}
