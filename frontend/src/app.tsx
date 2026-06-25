import { PropsWithChildren } from 'react';
import { useLaunch } from '@tarojs/taro';
import { ensureLogin } from './services/auth';
import './app.scss';

function App({ children }: PropsWithChildren) {
  useLaunch(() => {
    // 启动即静默登录，打通身份（失败不阻断，页面内可重试）
    ensureLogin().catch(() => {});
  });
  return children;
}

export default App;
