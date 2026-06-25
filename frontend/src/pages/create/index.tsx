import { useState, useMemo } from 'react';
import { View, Text, Input, Textarea, Picker, Switch } from '@tarojs/components';
import Taro, { useRouter, useDidShow } from '@tarojs/taro';
import { PlayType, type CreateActivityReq } from '@badminton/shared';
import { api } from '../../services/endpoints';
import { ensureLogin } from '../../services/auth';
import { toastError } from '../../services/api';
import { Empty, PageFrame } from '../../components';
import { fmtMonthDay, fmtWeekday, cleanRemark } from '../../utils/format';
import './index.scss';

/** 本地“日期 + 时间” → 后端 UTC ISO。页面挂钟时间按 Asia/Shanghai(+8) 处理。 */
function toIso(date: string, time: string): string {
  // date: 2026-06-27  time: 19:00
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  // 该挂钟时间视为 +8，对应 UTC = 本地毫秒 − 8h
  const utcMs = Date.UTC(y, mo - 1, d, h, mi) - 8 * 3600 * 1000;
  return new Date(utcMs).toISOString();
}

/** toIso 的逆：后端 UTC ISO → 本地(+8) 日期/时间字符串，供编辑回填 picker */
function fromIso(iso: string): { date: string; time: string } {
  const d = new Date(new Date(iso).getTime() + 8 * 3600 * 1000);
  const p = (n: number) => `${n}`.padStart(2, '0');
  const date = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  const time = `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
  return { date, time };
}

/** 默认：今天之后最近的周六 */
function nextSaturday(): string {
  const now = new Date(Date.now() + 8 * 3600 * 1000); // +8 当下
  const dow = now.getUTCDay(); // 0=周日
  const add = (6 - dow + 7) % 7 || 7;
  const t = new Date(now.getTime() + add * 86400 * 1000);
  const y = t.getUTCFullYear();
  const m = `${t.getUTCMonth() + 1}`.padStart(2, '0');
  const d = `${t.getUTCDate()}`.padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export default function Create() {
  const defDate = useMemo(nextSaturday, []);
  const router = useRouter();
  const editId = Number(router.params.id) || 0;
  const isEdit = editId > 0;

  const [title, setTitle] = useState('');
  const [startDate, setStartDate] = useState(defDate);
  const [startTime, setStartTime] = useState('19:00');
  const [endDate, setEndDate] = useState(defDate);
  const [endTime, setEndTime] = useState('21:00');
  const [ddlDate, setDdlDate] = useState(defDate);
  const [ddlTime, setDdlTime] = useState('12:00');
  const [venue, setVenue] = useState('');
  const [courtCount, setCourtCount] = useState(3);
  const [capacity, setCapacity] = useState(16);
  const [playType, setPlayType] = useState<PlayType>(PlayType.DOUBLES);
  const [mixedDoubles, setMixedDoubles] = useState(false);
  const [remark, setRemark] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // 编辑模式：首次进入拉取活动并回填表单（仅一次，避免覆盖用户改动）
  const [loaded, setLoaded] = useState(!isEdit);

  useDidShow(() => {
    if (!isEdit) return;
    if (loaded) return;
    void (async () => {
      try {
        await ensureLogin();
        const a = await api.getActivity(editId);
        setTitle(a.title);
        const s = fromIso(a.startAt);
        setStartDate(s.date);
        setStartTime(s.time);
        // 结束时间：历史活动可能无 endAt，回填为「开打 +2h」的合理默认，保证必填项有值
        const endSrc = a.endAt ?? new Date(new Date(a.startAt).getTime() + 2 * 3600 * 1000).toISOString();
        const eo = fromIso(endSrc);
        setEndDate(eo.date);
        setEndTime(eo.time);
        if (a.signupDeadline) {
          const dl = fromIso(a.signupDeadline);
          setDdlDate(dl.date);
          setDdlTime(dl.time);
        }
        setVenue(a.venue);
        setCourtCount(a.courtCount);
        setCapacity(a.capacity);
        setPlayType(a.playType);
        setMixedDoubles(a.mixedDoubles ?? false);
        setRemark(cleanRemark(a.remark));
        setLoaded(true);
      } catch (e) {
        toastError(e);
      }
    })();
  });

  const startIso = toIso(startDate, startTime);
  const endIso = toIso(endDate, endTime);
  const ddlIso = toIso(ddlDate, ddlTime);

  // 日期格只显示「月日 + 星期」（6月28日 周六），时间交给右侧时间选择器，避免同一时间展示两遍
  const dateLabel = (iso: string) => `${fmtMonthDay(iso)} ${fmtWeekday(iso)}`;
  const startLabel = dateLabel(startIso);
  const endLabel = dateLabel(endIso);
  const ddlLabel = dateLabel(ddlIso);

  const step = (v: number, delta: number, min: number, max: number) =>
    Math.min(max, Math.max(min, v + delta));

  const submit = async () => {
    if (submitting) return;
    if (!title.trim()) {
      Taro.showToast({ title: '请填写活动标题', icon: 'none' });
      return;
    }
    if (!venue.trim()) {
      Taro.showToast({ title: '请填写场馆 / 地点', icon: 'none' });
      return;
    }
    if (endIso <= startIso) {
      Taro.showToast({ title: '结束时间需晚于开打时间', icon: 'none' });
      return;
    }
    setSubmitting(true);
    try {
      await ensureLogin();
      const req: CreateActivityReq = {
        title: title.trim(),
        startAt: startIso,
        endAt: endIso,
        venue: venue.trim(),
        courtCount,
        capacity,
        signupDeadline: ddlIso,
        playType,
        // 分组模式不再在建局设置，改由分组向导（开打时）选择
        // 混双仅双打有意义；单打强制 false，避免脏数据
        mixedDoubles: playType === PlayType.DOUBLES ? mixedDoubles : false,
        remark: remark.trim() || null,
      };
      if (isEdit) {
        await api.updateActivity(editId, req);
        Taro.showToast({ title: '已保存修改', icon: 'success' });
        Taro.navigateBack();
      } else {
        const created = await api.createActivity(req);
        Taro.showToast({ title: '发布成功', icon: 'success' });
        // 进入活动详情并自动弹出分享卡预览（share=1），形成「建局→分享卡」闭环
        Taro.redirectTo({ url: `/pages/activity/index?id=${created.id}&share=1` });
      }
    } catch (e) {
      toastError(e);
    } finally {
      setSubmitting(false);
    }
  };

  const pageTitle = isEdit ? '编辑活动' : '发起活动';

  const footerNode = (
    <View
      className={`create__submit ${submitting ? 'create__submit--disabled' : ''}`}
      onClick={submit}
    >
      {submitting
        ? isEdit
          ? '保存中…'
          : '发布中…'
        : isEdit
          ? '保存修改'
          : '发布 · 邀请球友'}
    </View>
  );

  if (isEdit && !loaded) {
    return (
      <PageFrame title={pageTitle} activeTab="home">
        <View className="create--loading">
          <Empty text="加载中…" />
        </View>
      </PageFrame>
    );
  }

  return (
    <PageFrame title={pageTitle} activeTab="home" footer={footerNode}>
      <View className="create__form">
        {/* 活动标题 */}
        <View className="field">
          <Text className="field__label">活动标题</Text>
          <View className="field__box">
            <Input
              className="field__input"
              value={title}
              placeholder="周六晚 · 高手羽你局"
              placeholderClass="field__ph"
              maxlength={30}
              onInput={(e) => setTitle(e.detail.value)}
            />
          </View>
        </View>

        {/* 开打时间 + 结束时间 */}
        <View className="field-row">
          <View className="field field--half">
            <Text className="field__label">开打时间</Text>
            <View className="field__pickers">
              <Picker mode="date" value={startDate} onChange={(e) => setStartDate(e.detail.value)}>
                <View className="picker-cell picker-cell--date">
                  <Text className="picker-cell__val">{startLabel}</Text>
                  <Text className="picker-cell__arrow">▾</Text>
                </View>
              </Picker>
              <Picker mode="time" value={startTime} onChange={(e) => setStartTime(e.detail.value)}>
                <View className="picker-cell picker-cell--time">
                  <Text className="picker-cell__time num">{startTime}</Text>
                </View>
              </Picker>
            </View>
          </View>
          <View className="field field--half">
            <Text className="field__label">结束时间</Text>
            <View className="field__pickers">
              <Picker mode="date" value={endDate} onChange={(e) => setEndDate(e.detail.value)}>
                <View className="picker-cell picker-cell--date">
                  <Text className="picker-cell__val">{endLabel}</Text>
                  <Text className="picker-cell__arrow">▾</Text>
                </View>
              </Picker>
              <Picker mode="time" value={endTime} onChange={(e) => setEndTime(e.detail.value)}>
                <View className="picker-cell picker-cell--time">
                  <Text className="picker-cell__time num">{endTime}</Text>
                </View>
              </Picker>
            </View>
          </View>
        </View>

        {/* 报名截止 */}
        <View className="field">
          <Text className="field__label">报名截止</Text>
          <View className="field__pickers">
            <Picker mode="date" value={ddlDate} onChange={(e) => setDdlDate(e.detail.value)}>
              <View className="picker-cell picker-cell--date">
                <Text className="picker-cell__val">{ddlLabel}</Text>
                <Text className="picker-cell__arrow">▾</Text>
              </View>
            </Picker>
            <Picker mode="time" value={ddlTime} onChange={(e) => setDdlTime(e.detail.value)}>
              <View className="picker-cell picker-cell--time">
                <Text className="picker-cell__time num">{ddlTime}</Text>
              </View>
            </Picker>
          </View>
        </View>

        {/* 场馆 / 地点 */}
        <View className="field">
          <Text className="field__label">场馆 / 地点</Text>
          <View className="field__box">
            <Input
              className="field__input"
              value={venue}
              placeholder="奥森羽毛球馆"
              placeholderClass="field__ph"
              maxlength={40}
              onInput={(e) => setVenue(e.detail.value)}
            />
          </View>
        </View>

        {/* 场地数 + 人数上限 */}
        <View className="field-row">
          <View className="field field--half">
            <Text className="field__label">场地数</Text>
            <View className="stepper">
              <View
                className="stepper__btn"
                onClick={() => setCourtCount((v) => step(v, -1, 1, 12))}
              >
                −
              </View>
              <Text className="stepper__val num">{courtCount}</Text>
              <View
                className="stepper__btn stepper__btn--plus"
                onClick={() => setCourtCount((v) => step(v, 1, 1, 12))}
              >
                +
              </View>
            </View>
          </View>
          <View className="field field--half">
            <Text className="field__label">人数上限</Text>
            <View className="stepper">
              <View
                className="stepper__btn"
                onClick={() => setCapacity((v) => step(v, -1, 2, 64))}
              >
                −
              </View>
              <Text className="stepper__val num">{capacity}</Text>
              <View
                className="stepper__btn stepper__btn--plus"
                onClick={() => setCapacity((v) => step(v, 1, 2, 64))}
              >
                +
              </View>
            </View>
          </View>
        </View>

        {/* 玩法 */}
        <View className="field">
          <Text className="field__label">玩法</Text>
          <View className="seg">
            <View
              className={`seg__item ${playType === PlayType.DOUBLES ? 'seg__item--on' : ''}`}
              onClick={() => setPlayType(PlayType.DOUBLES)}
            >
              双打 <Text className="seg__sub num">2v2</Text>
            </View>
            <View
              className={`seg__item ${playType === PlayType.SINGLES ? 'seg__item--on' : ''}`}
              onClick={() => setPlayType(PlayType.SINGLES)}
            >
              单打 <Text className="seg__sub num">1v1</Text>
            </View>
          </View>
        </View>

        {/* 混双（仅双打可选）：分组时每队尽量一男一女 */}
        <View className={`switch-row ${playType !== PlayType.DOUBLES ? 'switch-row--off' : ''}`}>
          <View className="switch-row__main">
            <Text className="switch-row__title">混双搭配</Text>
            <Text className="switch-row__sub">
              {playType === PlayType.DOUBLES ? '分组时每队尽量一男一女' : '仅双打可选'}
            </Text>
          </View>
          <Switch
            checked={playType === PlayType.DOUBLES && mixedDoubles}
            disabled={playType !== PlayType.DOUBLES}
            color="#16a34a"
            onChange={(e) => setMixedDoubles(e.detail.value)}
          />
        </View>

        {/* 备注 */}
        <View className="field">
          <Text className="field__label">备注（选填）</Text>
          <View className="field__box field__box--area">
            <Textarea
              className="field__textarea"
              value={remark}
              placeholder="自带球拍，提前 10 分钟到场热身～"
              placeholderClass="field__ph"
              maxlength={120}
              onInput={(e) => setRemark(e.detail.value)}
            />
          </View>
        </View>

        <View className="create__pad" />
      </View>
    </PageFrame>
  );
}
