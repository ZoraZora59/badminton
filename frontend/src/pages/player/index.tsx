/**
 * 球友战绩（只读）——和底部「战绩」tab 用的是同一个页面组件，只是挂在一个非 tabBar 路由上。
 *
 * 为什么要多这么一个路由：`pages/profile/index` 注册在 app.config.ts 的 tabBar.list 里，
 * 而微信小程序禁止 navigateTo / redirectTo 打开 tabBar 页面（switchTab 虽然允许，却不能带 query），
 * 所以「在球局里点某人头像看他战绩」没办法直接跳 profile。
 *
 * 这里复用同一个组件挂普通路由，一举两得：底部「战绩」tab 原样保留，
 * 详情页又有正常的返回栈——看完某个球友的战绩能退回到原来那场球局，
 * 而不是像 reLaunch 那样把页面栈清空、退到首页（16 人的名单挨个点会非常难受）。
 *
 * Profile 组件本身已经完整适配了 `?id=` 只读态（显示返回箭头、隐藏「分享我的战绩」、
 * 收紧底部留白），所以这里不需要任何额外分支。
 */
import Profile from '../profile/index';

export default Profile;
