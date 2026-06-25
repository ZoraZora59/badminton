import type { ReactNode } from 'react';
import { View, Text, Button } from '@tarojs/components';
import './index.scss';

interface Props {
  visible: boolean;
  onClose: () => void;
  /** 卡片可视内容（活动卡 / 战报卡），由调用页渲染 */
  children: ReactNode;
  /** 转发按钮文案 */
  forwardLabel?: string;
  /** 转发按钮下方的引导小字 */
  tip?: string;
}

/**
 * 分享卡预览弹层：上方展示卡片可视内容，下方「转发给球友」按钮（openType=share，
 * 触发所在页的 useShareAppMessage）。把「生成分享卡」从单纯 toast / 原生分享升级为可见预览闭环。
 */
export default function ShareCard({ visible, onClose, children, forwardLabel = '转发给球友', tip }: Props) {
  if (!visible) return null;
  return (
    <View className="sharecard" catchMove>
      <View className="sharecard__mask" onClick={onClose} />
      <View className="sharecard__panel">
        <View className="sharecard__close" onClick={onClose}>
          <Text className="sharecard__close-x">✕</Text>
        </View>
        <View className="sharecard__card">{children}</View>
        <Button
          className="sharecard__forward bm-btn bm-btn--solid bm-btn--block"
          openType="share"
          hoverClass="none"
          onClick={onClose}
        >
          {forwardLabel}
        </Button>
        {tip ? <Text className="sharecard__tip">{tip}</Text> : null}
      </View>
    </View>
  );
}
