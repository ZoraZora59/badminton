import type { UserConfigExport } from '@tarojs/cli';

const config: UserConfigExport = {
  projectName: 'badminton',
  date: '2026-6-24',
  designWidth: 375,
  deviceRatio: { 375: 2 / 1, 640: 2.34 / 2, 750: 1, 828: 1.81 / 2 },
  sourceRoot: 'src',
  outputRoot: 'dist',
  plugins: [],
  defineConstants: {},
  copy: { patterns: [], options: {} },
  framework: 'react',
  compiler: 'webpack5',
  cache: { enable: false },
  mini: {
    postcss: {
      pxtransform: { enable: true, config: {} },
      url: { enable: true, config: { limit: 1024 } },
      cssModules: { enable: false },
    },
  },
  h5: {},
};

export default function (merge: (...args: object[]) => object) {
  if (process.env.NODE_ENV === 'development') {
    return merge({}, config, { mini: {}, h5: {} });
  }
  return merge({}, config, { mini: {}, h5: {} });
}
