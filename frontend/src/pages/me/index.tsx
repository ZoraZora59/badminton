import { useState, useCallback } from 'react';
import { View, Text, Input, Button, ScrollView } from '@tarojs/components';
import Taro, { useDidShow, useShareAppMessage } from '@tarojs/taro';
import { Gender, SkillLevel, DEFAULT_LEVEL, levelLabel, type UserVM } from '@badminton/shared';
import { api } from '../../services/endpoints';
import { ensureLogin } from '../../services/auth';
import { useUser, setUser } from '../../store/user';
import { toastError } from '../../services/api';
import { Avatar, LevelSheet } from '../../components';
import './index.scss';

const GENDERS: { key: Gender; label: string }[] = [
  { key: Gender.MALE, label: '男' },
  { key: Gender.FEMALE, label: '女' },
  { key: Gender.UNKNOWN, label: '不填' },
];

export default function Me() {
  const user = useUser();
  const [nickname, setNickname] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');
  const [gender, setGender] = useState<Gender>(Gender.UNKNOWN);
  const [level, setLevel] = useState<SkillLevel>(DEFAULT_LEVEL);
  const [sheet, setSheet] = useState(false);
  const [saving, setSaving] = useState(false);

  // 用最新资料预填表单（进入页 / 返回页都会拉一次）
  const fill = useCallback((u: UserVM) => {
    setNickname(u.nickname || '');
    setAvatarUrl(u.avatarUrl || '');
    setGender(u.gender || Gender.UNKNOWN);
    setLevel(u.defaultLevel || DEFAULT_LEVEL);
  }, []);

  const load = useCallback(async () => {
    try {
      await ensureLogin();
      const me = await api.getMe();
      setUser(me);
      fill(me);
    } catch (e) {
      toastError(e);
    }
  }, [fill]);

  useDidShow(() => {
    load();
  });

  // 「我的」转发即邀请：落到首页约球入口（个人设置页不挂朋友圈）
  useShareAppMessage(() => ({
    title: '羽毛球小助手｜建局、报名、计分一条龙，一起来约球',
    path: '/pages/home/index',
  }));

  const save = async () => {
    if (saving) return;
    const nick = nickname.trim();
    if (!nick) {
      Taro.showToast({ title: '请填写昵称', icon: 'none' });
      return;
    }
    setSaving(true);
    try {
      const updated = await api.updateMe({
        nickname: nick,
        avatarUrl,
        gender,
        defaultLevel: level,
      });
      setUser(updated);
      fill(updated);
      Taro.showToast({ title: '已保存', icon: 'success' });
    } catch (e) {
      toastError(e);
    } finally {
      setSaving(false);
    }
  };

  // 微信「头像填写」：chooseAvatar 给临时路径 → 压缩 → 读 base64 data URL（参考 camping，避免上传/静态/域名白名单）
  const onChooseAvatar = async (e: { detail: { avatarUrl: string } }) => {
    const tmp = e.detail?.avatarUrl;
    if (!tmp) return;
    try {
      const { tempFilePath } = await Taro.compressImage({ src: tmp, quality: 60 });
      const b64 = Taro.getFileSystemManager().readFileSync(tempFilePath, 'base64') as string;
      setAvatarUrl(`data:image/jpeg;base64,${b64}`);
    } catch {
      try {
        const b64 = Taro.getFileSystemManager().readFileSync(tmp, 'base64') as string;
        setAvatarUrl(`data:image/png;base64,${b64}`);
      } catch {
        Taro.showToast({ title: '头像读取失败', icon: 'none' });
      }
    }
  };

  const goMySignups = () => {
    Taro.switchTab({ url: '/pages/home/index' });
  };
  const showHelp = () => {
    Taro.showModal({
      title: '帮助',
      content: '发起球局 → 分享到群 → 大家报名 → 现场签到 → 智能分组 → 实时计分结算。点右下角「+」即可发起新局。',
      showCancel: false,
      confirmText: '知道了',
    });
  };
  const showAbout = () => {
    Taro.showModal({
      title: '关于「羽毛球小助手」',
      content: '一款专为羽毛球爱好者打造的组局小程序：约球、报名、分组、计分一站搞定。跨局战绩按微信账号汇总。',
      showCancel: false,
      confirmText: '好的',
    });
  };

  const headName = nickname.trim() || user?.nickname || '球友';

  return (
    <View className="me">
      {/* 绿色 Hero：当前头像 + 昵称 + 水平徽标 */}
      <View className="me__header">
        <View className="me__statusbar" />
        <View className="me__deco" />
        <View className="me__hero">
          <Avatar name={headName} src={avatarUrl} size={58} ring />
          <View className="me__hero-info">
            <Text className="me__hero-name">{headName}</Text>
            <View className="me__hero-badge">
              <Text className="me__hero-badge-txt">{levelLabel(level)}</Text>
            </View>
          </View>
        </View>
      </View>

      <ScrollView scrollY className="me__body">
        <View className="me__inner">
        {/* 资料卡 */}
        <View className="card me__card">
          {/* 头像（微信 chooseAvatar） */}
          <View className="row row--avatar">
            <Text className="row__label">头像</Text>
            <Button className="me__avatar-btn" openType="chooseAvatar" onChooseAvatar={onChooseAvatar}>
              <Avatar name={headName} src={avatarUrl} size={48} />
              <View className="me__avatar-cam">
                <View className="me__cam-icon" />
              </View>
            </Button>
          </View>

          <View className="row__sep" />

          {/* 昵称（微信 nickname 填充） */}
          <View className="row">
            <Text className="row__label">昵称</Text>
            <Input
              className="me__nick-input"
              type="nickname"
              value={nickname}
              placeholder="点此使用微信昵称"
              placeholderClass="me__ph"
              maxlength={20}
              onInput={(e) => setNickname(e.detail.value)}
              onBlur={(e) => setNickname(e.detail.value)}
            />
          </View>

          {/* 性别 分段 */}
          <View className="field me__field">
            <Text className="field__label">性别</Text>
            <View className="seg">
              {GENDERS.map((g) => (
                <View
                  key={g.key}
                  className={`seg__item ${gender === g.key ? 'seg__item--on' : ''}`}
                  onClick={() => setGender(g.key)}
                >
                  {g.label}
                </View>
              ))}
            </View>
          </View>

          {/* 默认水平 → LevelSheet */}
          <View className="field me__field">
            <Text className="field__label">水平</Text>
            <View className="me__level" onClick={() => setSheet(true)}>
              <View className="me__level-left">
                <View className="me__level-badge num">{level}</View>
                <Text className="me__level-txt">{levelLabel(level)}</Text>
              </View>
              <Text className="me__level-arrow">›</Text>
            </View>
          </View>

          <View
            className={`me__save ${saving ? 'me__save--disabled' : ''}`}
            onClick={save}
          >
            {saving ? '保存中…' : '保存'}
          </View>
        </View>

        {/* 列表项 */}
        <View className="card me__list">
          <View className="li" onClick={goMySignups}>
            <View className="li__ico li__ico--signup" />
            <Text className="li__txt">我的报名</Text>
            <Text className="li__arrow">›</Text>
          </View>
          <View className="li__sep" />
          <View className="li" onClick={showHelp}>
            <View className="li__ico li__ico--help" />
            <Text className="li__txt">帮助</Text>
            <Text className="li__arrow">›</Text>
          </View>
          <View className="li__sep" />
          <View className="li" onClick={showAbout}>
            <View className="li__ico li__ico--about" />
            <Text className="li__txt">关于</Text>
            <Text className="li__arrow">›</Text>
          </View>
        </View>

        <Text className="me__hint">头像与昵称使用微信授权，仅保存到「羽毛球小助手」用于组局展示。</Text>
        <View className="me__pad" />
        </View>
      </ScrollView>

      <LevelSheet
        visible={sheet}
        value={level}
        title="选择水平"
        onConfirm={(lv) => {
          setLevel(lv);
          setSheet(false);
        }}
        onClose={() => setSheet(false)}
      />
    </View>
  );
}
