import { useState, useEffect } from 'react';
import { View, Text, Input } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { Gender, LEVELS, SkillLevel, DEFAULT_LEVEL, levelLabel } from '@badminton/shared';
import './index.scss';

const GENDERS: { key: Gender; label: string }[] = [
  { key: Gender.MALE, label: '男' },
  { key: Gender.FEMALE, label: '女' },
  { key: Gender.UNKNOWN, label: '不填' },
];

interface Props {
  visible: boolean;
  /** add = 新增临时球友；edit = 编辑已有球友（含 +1 带人占位） */
  mode?: 'add' | 'edit';
  name?: string;
  gender?: Gender;
  level?: SkillLevel;
  onConfirm: (data: { name: string; gender: Gender; level: SkillLevel }) => void;
  onClose: () => void;
}

/**
 * 临时球友录入弹层：昵称 + 性别 + 本场水平，加人/改人共用。
 * 性别是混双强制配队的输入；不填按 UNKNOWN（引擎视作可搭配）。
 */
export default function GuestSheet({
  visible,
  mode = 'add',
  name = '',
  gender = Gender.UNKNOWN,
  level = DEFAULT_LEVEL,
  onConfirm,
  onClose,
}: Props) {
  const [n, setN] = useState(name);
  const [g, setG] = useState<Gender>(gender);
  const [lv, setLv] = useState<SkillLevel>(level);

  useEffect(() => {
    if (visible) {
      setN(name);
      setG(gender);
      setLv(level);
    }
  }, [visible, name, gender, level]);

  if (!visible) return null;

  const valid = n.trim().length > 0;
  const submit = () => {
    if (!valid) {
      Taro.showToast({ title: '请输入球友昵称', icon: 'none' });
      return;
    }
    onConfirm({ name: n.trim(), gender: g, level: lv });
  };

  return (
    <View className="bm-sheet">
      <View className="bm-sheet__mask" onClick={onClose} />
      <View className="bm-sheet__panel">
        <View className="bm-sheet__handle" />
        <View className="bm-sheet__head">
          <View>
            <Text className="bm-sheet__title">{mode === 'add' ? '添加临时球友' : '编辑临时球友'}</Text>
            <Text className="bm-sheet__sub">开了混双按性别配队，建议把性别填准</Text>
          </View>
          <View className="bm-sheet__close" onClick={onClose}>✕</View>
        </View>

        <View className="gs__field">
          <Text className="gs__label">昵称</Text>
          <Input
            className="gs__input"
            value={n}
            placeholder="球友昵称（无微信占位）"
            placeholderClass="gs__ph"
            maxlength={20}
            onInput={(e) => setN(e.detail.value)}
            onBlur={(e) => setN(e.detail.value)}
          />
        </View>

        <View className="gs__field">
          <Text className="gs__label">性别</Text>
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

        <View className="gs__field">
          <Text className="gs__label">本场水平</Text>
          <View className="gs__levels">
            {LEVELS.map((l) => (
              <View
                key={l.level}
                className={`gs__lv ${lv === l.level ? 'gs__lv--on' : ''}`}
                onClick={() => setLv(l.level)}
              >
                <Text className="gs__lv-badge num">{l.level}</Text>
                <Text className="gs__lv-title">{l.title}</Text>
              </View>
            ))}
          </View>
        </View>

        <View
          className={`bm-sheet__confirm ${valid ? '' : 'bm-sheet__confirm--disabled'}`}
          onClick={submit}
        >
          {mode === 'add' ? '添加' : '保存'} · {levelLabel(lv)}
        </View>
      </View>
    </View>
  );
}
