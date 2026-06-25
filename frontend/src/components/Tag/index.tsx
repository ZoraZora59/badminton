import { View } from '@tarojs/components';
import './index.scss';

type Tone = 'primary' | 'warn' | 'muted' | 'success' | 'accent';

interface Props {
  text: string;
  tone?: Tone;
}

export default function Tag({ text, tone = 'success' }: Props) {
  return <View className={`bm-tag bm-tag--${tone}`}>{text}</View>;
}
