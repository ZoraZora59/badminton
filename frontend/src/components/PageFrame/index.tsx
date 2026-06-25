import type { ReactNode } from 'react';
import { View, Text, ScrollView } from '@tarojs/components';
import { goBack } from '../../utils/nav';
import BottomTab, { type TabKey } from '../BottomTab';
import './index.scss';

interface Props {
  /** 顶部小 header 标题 */
  title: string;
  /** 是否显示返回（默认显示）；tab 页根可关 */
  back?: boolean;
  /** 返回回调，默认安全返回（无上级回主页） */
  onBack?: () => void;
  /** header 右侧操作槽（可选） */
  headerRight?: ReactNode;
  /** 固定在 header 下、主体上方的次级头部（步骤条/轮次切换等，不随主体滚动） */
  subHeader?: ReactNode;
  /** 底部常驻 tab 高亮项；不传则不渲染底部 tab（如 tab 页交给原生） */
  activeTab?: TabKey;
  /** 底部操作区，浮在 tab 栏正上方（可选） */
  footer?: ReactNode;
  /** footer 去掉默认白底/分隔线，用页面背景（适配灰底操作区） */
  footerBare?: boolean;
  /** 弹层/Modal：渲染在框架内、滚动区外，避免被 ScrollView 裁剪 */
  overlay?: ReactNode;
  children: ReactNode;
}

/**
 * 全站统一页面框架：固定顶部小 header + 可选次级头部 + 可滚动主体 + 可选底部操作区 + 底部常驻 tab。
 * 页面间差异集中在主体（children），顶部/底部保持一致。
 */
export default function PageFrame({
  title,
  back = true,
  onBack,
  headerRight,
  subHeader,
  activeTab,
  footer,
  footerBare,
  overlay,
  children,
}: Props) {
  return (
    <View className="pf">
      <View className="pf__header">
        <View className="pf__statusbar" />
        <View className="pf__bar">
          {back ? (
            <View className="pf__back" onClick={onBack ?? goBack}>
              <Text className="pf__back-arrow">‹</Text>
            </View>
          ) : (
            <View className="pf__slot" />
          )}
          <Text className="pf__title">{title}</Text>
          <View className="pf__slot pf__slot--right">{headerRight}</View>
        </View>
      </View>

      {subHeader ? <View className="pf__subheader">{subHeader}</View> : null}

      <ScrollView scrollY className="pf__body">
        {children}
      </ScrollView>

      {footer ? (
        <View className={`pf__footer ${footerBare ? 'pf__footer--bare' : ''}`}>{footer}</View>
      ) : null}
      {activeTab ? <BottomTab active={activeTab} /> : null}
      {overlay}
    </View>
  );
}
