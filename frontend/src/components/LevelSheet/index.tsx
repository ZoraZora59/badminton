import { useState, useEffect } from 'react';
import { View, Text } from '@tarojs/components';
import { LEVELS, SkillLevel, levelLabel } from '@badminton/shared';
import './index.scss';

interface Props {
  visible: boolean;
  value?: SkillLevel;
  title?: string;
  onConfirm: (level: SkillLevel) => void;
  onClose: () => void;
}

/** 选择水平 · 分级说明（设计稿⑩）：6 级各带一句话，说明即选项 */
export default function LevelSheet({ visible, value = SkillLevel.L3, title = '选择本场水平', onConfirm, onClose }: Props) {
  const [sel, setSel] = useState<SkillLevel>(value);
  useEffect(() => {
    if (visible) setSel(value);
  }, [visible, value]);

  if (!visible) return null;
  return (
    <View className="bm-sheet">
      <View className="bm-sheet__mask" onClick={onClose} />
      <View className="bm-sheet__panel">
        <View className="bm-sheet__handle" />
        <View className="bm-sheet__head">
          <View>
            <Text className="bm-sheet__title">{title}</Text>
            <Text className="bm-sheet__sub">中羽业余分级 · 不确定就选最近水平，局长可微调</Text>
          </View>
          <View className="bm-sheet__close" onClick={onClose}>✕</View>
        </View>
        <View className="bm-sheet__list">
          {LEVELS.map((l) => (
            <View key={l.level} className={`bm-lv ${sel === l.level ? 'bm-lv--on' : ''}`} onClick={() => setSel(l.level)}>
              <View className="bm-lv__badge num">{l.level}</View>
              <View className="bm-lv__body">
                <View className="bm-lv__name">
                  {l.title}
                  {l.default ? <Text className="bm-lv__default">默认</Text> : null}
                </View>
                <Text className="bm-lv__desc">{l.desc}</Text>
              </View>
              <View className={`bm-lv__radio ${sel === l.level ? 'bm-lv__radio--on' : ''}`}>{sel === l.level ? '✓' : ''}</View>
            </View>
          ))}
        </View>
        <View className="bm-sheet__confirm" onClick={() => onConfirm(sel)}>
          确定 · {levelLabel(sel)}
        </View>
      </View>
    </View>
  );
}
