import { View, Image, Text } from '@tarojs/components';
import { initial } from '../../utils/format';
import './index.scss';

interface Props {
  name?: string;
  src?: string | null;
  size?: number;
  ring?: boolean;
}

/** 头像：有 src 显示图片，否则显示首字色块（贴合设计稿头像墙） */
export default function Avatar({ name = '', src, size = 38, ring = false }: Props) {
  const style = { width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.36)}px` };
  return (
    <View className={`bm-avatar ${ring ? 'bm-avatar--ring' : ''}`} style={style}>
      {src ? <Image className="bm-avatar__img" src={src} mode="aspectFill" /> : <Text className="bm-avatar__txt">{initial(name)}</Text>}
    </View>
  );
}
