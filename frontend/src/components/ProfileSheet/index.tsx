import { useState, useEffect } from 'react';
import { View, Text, Input, Button } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { Gender } from '@badminton/shared';
import Avatar from '../Avatar';
import './index.scss';

const GENDERS: { key: Gender; label: string }[] = [
  { key: Gender.MALE, label: '男' },
  { key: Gender.FEMALE, label: '女' },
  { key: Gender.UNKNOWN, label: '不填' },
];

/** 后端建号时写死的占位昵称：等价于「这人还没填过资料」 */
const PLACEHOLDER_NICK = '球友';

interface Props {
  visible: boolean;
  /** 当前昵称；等于占位「球友」时按空处理，让用户直接用微信昵称填 */
  nickname?: string;
  avatarUrl?: string;
  gender?: Gender;
  /** 确认键文案；名单满员时调用方要传「保存并候补」，别让按钮和接下来发生的事对不上 */
  confirmText?: string;
  /** 跳过键文案，同上 */
  skipText?: string;
  /** 保存：交给调用方写库（await 期间弹层内显示「保存中…」） */
  onConfirm: (data: { nickname: string; avatarUrl: string; gender: Gender }) => Promise<void> | void;
  /** 跳过（含点遮罩/关闭）：不写库，调用方继续原本的动作，绝不阻断报名 */
  onSkip: () => void;
}

/**
 * 报名前的「先让人认出你」弹层：头像 + 昵称 + 性别。
 *
 * 从群链接点进来的新人建号是 nickname='球友' / avatarUrl=''，不填就会出现
 * 「三个新人报名、头像墙上三个一样的灰圈球友」。这里在第一次报名前顺手补一次。
 * 不放「水平」——水平自评有社交压力，留给局长在签到页定。
 * 任何时候都能跳过：挡住报名比认不出人更糟。
 */
export default function ProfileSheet({
  visible,
  nickname = '',
  avatarUrl = '',
  gender = Gender.UNKNOWN,
  confirmText = '保存并报名',
  skipText = '先跳过，直接报名',
  onConfirm,
  onSkip,
}: Props) {
  const [n, setN] = useState('');
  const [av, setAv] = useState('');
  const [g, setG] = useState<Gender>(gender);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (visible) {
      setN(nickname === PLACEHOLDER_NICK ? '' : nickname);
      setAv(avatarUrl);
      setG(gender);
      setSaving(false);
    }
  }, [visible, nickname, avatarUrl, gender]);

  if (!visible) return null;

  // 微信「头像填写」：chooseAvatar 给临时路径 → 压缩 → 读 base64 data URL（与「我的」页一致）
  const onChooseAvatar = async (e: { detail: { avatarUrl: string } }) => {
    const tmp = e.detail?.avatarUrl;
    if (!tmp) return;
    try {
      const { tempFilePath } = await Taro.compressImage({ src: tmp, quality: 60 });
      const b64 = Taro.getFileSystemManager().readFileSync(tempFilePath, 'base64') as string;
      setAv(`data:image/jpeg;base64,${b64}`);
    } catch {
      try {
        const b64 = Taro.getFileSystemManager().readFileSync(tmp, 'base64') as string;
        setAv(`data:image/png;base64,${b64}`);
      } catch {
        Taro.showToast({ title: '头像读取失败', icon: 'none' });
      }
    }
  };

  const valid = n.trim().length > 0;
  const submit = async () => {
    if (saving) return;
    if (!valid) {
      Taro.showToast({ title: '写个名字，球友才认得出你', icon: 'none' });
      return;
    }
    setSaving(true);
    try {
      await onConfirm({ nickname: n.trim(), avatarUrl: av, gender: g });
    } finally {
      setSaving(false);
    }
  };

  const headName = n.trim() || PLACEHOLDER_NICK;

  return (
    <View className="bm-sheet">
      <View className="bm-sheet__mask" onClick={() => !saving && onSkip()} />
      <View className="bm-sheet__panel">
        <View className="bm-sheet__handle" />
        <View className="bm-sheet__head">
          <View>
            <Text className="bm-sheet__title">先让球友认出你</Text>
            <Text className="bm-sheet__sub">名单上都叫「球友」的话，局长会在群里挨个问是谁</Text>
          </View>
          <View className="bm-sheet__close" onClick={() => !saving && onSkip()}>✕</View>
        </View>

        {/* 头像（微信 chooseAvatar） */}
        <View className="ps__avatar-row">
          <Button className="ps__avatar-btn" openType="chooseAvatar" onChooseAvatar={onChooseAvatar}>
            <Avatar name={headName} src={av} size={56} />
            <View className="ps__avatar-cam">
              <View className="ps__cam-icon" />
            </View>
          </Button>
          <Text className="ps__avatar-tip">点头像用微信头像</Text>
        </View>

        {/* 昵称（微信 nickname 填充） */}
        <View className="ps__field">
          <Text className="ps__label">昵称</Text>
          <Input
            className="ps__input"
            type="nickname"
            value={n}
            placeholder="点此使用微信昵称"
            placeholderClass="ps__ph"
            maxlength={20}
            onInput={(e) => setN(e.detail.value)}
            onBlur={(e) => setN(e.detail.value)}
          />
        </View>

        {/* 性别（混双配队要用，不填按不限） */}
        <View className="ps__field">
          <Text className="ps__label">性别</Text>
          <View className="seg">
            {GENDERS.map((x) => (
              <View
                key={x.key}
                className={`seg__item ${g === x.key ? 'seg__item--on' : ''}`}
                onClick={() => setG(x.key)}
              >
                {x.label}
              </View>
            ))}
          </View>
        </View>

        <View
          className={`bm-sheet__confirm ${valid && !saving ? '' : 'bm-sheet__confirm--disabled'}`}
          onClick={submit}
        >
          {saving ? '保存中…' : confirmText}
        </View>
        <View className="ps__skip" onClick={() => !saving && onSkip()}>
          {skipText}
        </View>
      </View>
    </View>
  );
}
