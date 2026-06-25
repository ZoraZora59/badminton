/// <reference types="@tarojs/taro" />

declare module '*.scss';
declare module '*.css';
declare module '*.png';
declare module '*.svg';

declare const process: {
  env: {
    NODE_ENV: 'development' | 'production';
    TARO_ENV: 'weapp' | 'h5' | string;
    [key: string]: string | undefined;
  };
};
