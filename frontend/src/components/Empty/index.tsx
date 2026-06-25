import { View, Text } from '@tarojs/components';
import './index.scss';

interface Props {
  text?: string;
  hint?: string;
}

export default function Empty({ text = '还没有内容', hint }: Props) {
  return (
    <View className="bm-empty">
      <View className="bm-empty__icon">🏸</View>
      <Text className="bm-empty__text">{text}</Text>
      {hint ? <Text className="bm-empty__hint">{hint}</Text> : null}
    </View>
  );
}
