import Taro from '@tarojs/taro';

/** 主页（球局 tab），作为无上级页面时的兜底落点 */
const HOME_TAB = '/pages/home/index';

/**
 * 安全返回「上级」页面：
 * - 正常导航栈（栈深 > 1）：返回上一页
 * - 通过分享链接直达、栈里只有当前页：回主页 tab，
 *   避免 navigateBack 在首页报 "cannot navigate back at first page"
 */
export function goBack(): void {
  if (Taro.getCurrentPages().length > 1) {
    Taro.navigateBack();
  } else {
    Taro.switchTab({ url: HOME_TAB });
  }
}
