import { View } from '@tarojs/components';
import './index.scss';

interface Props {
  text: string;
  onClick?: () => void;
  variant?: 'solid' | 'outline';
  disabled?: boolean;
  block?: boolean;
}

/** 主操作按钮（≥44px 触达，贴合设计稿绿色大按钮） */
export default function PrimaryButton({ text, onClick, variant = 'solid', disabled, block = true }: Props) {
  return (
    <View
      className={`bm-btn bm-btn--${variant} ${block ? 'bm-btn--block' : ''} ${disabled ? 'bm-btn--disabled' : ''}`}
      onClick={() => !disabled && onClick?.()}
    >
      {text}
    </View>
  );
}
