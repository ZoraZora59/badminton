import { View } from '@tarojs/components';
import './index.scss';

export type IconName = 'clock' | 'pin' | 'share' | 'trophy' | 'check' | 'users' | 'court' | 'grid' | 'user';

/** 线性图标集（24×24，stroke 风格）—— 替代 emoji，统一正式感。stroke 颜色由 color 注入。 */
const SVG: Record<IconName, string> = {
  clock: "<circle cx='12' cy='12' r='9'/><path d='M12 7v5l3 2'/>",
  pin: "<path d='M12 21s-6-5.3-6-10a6 6 0 1 1 12 0c0 4.7-6 10-6 10z'/><circle cx='12' cy='11' r='2.2'/>",
  share: "<path d='M21 3 11 13'/><path d='M21 3 14.5 21 11 13 3 9.5 21 3z'/>",
  trophy: "<path d='M8 21h8M12 17v4M7 4h10v4a5 5 0 0 1-10 0V4zM7 6H4v2a3 3 0 0 0 3 3M17 6h3v2a3 3 0 0 1-3 3'/>",
  check: "<path d='M5 13l4 4L19 7'/>",
  users:
    "<path d='M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2'/><circle cx='9' cy='7' r='4'/><path d='M22 21v-2a4 4 0 0 0-3-3.87M16 3.13A4 4 0 0 1 16 11'/>",
  court: "<rect x='3' y='4' width='18' height='16' rx='1.5'/><path d='M12 4v16M3 12h18'/>",
  grid: "<rect x='3' y='3' width='7' height='7' rx='1.4'/><rect x='14' y='3' width='7' height='7' rx='1.4'/><rect x='3' y='14' width='7' height='7' rx='1.4'/><rect x='14' y='14' width='7' height='7' rx='1.4'/>",
  user: "<circle cx='12' cy='8' r='4'/><path d='M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1'/>",
};

interface Props {
  name: IconName;
  size?: number;
  color?: string;
}

export default function Icon({ name, size = 16, color = '#5b6b61' }: Props) {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='${color}' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'>${SVG[name]}</svg>`;
  const uri = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  return (
    <View
      className="bm-icon"
      style={{ width: `${size}px`, height: `${size}px`, backgroundImage: `url("${uri}")` }}
    />
  );
}
