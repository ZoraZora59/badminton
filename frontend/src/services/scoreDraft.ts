import Taro from '@tarojs/taro';

// 计分草稿：+1/−1 过程中的比分实时落到本地缓存，锁屏、小程序被系统回收、
// 页面 onShow 重新拉取都不会丢未提交的比分；提交成功或该局已被他人确认后清除。
// 草稿按 matchId 存放在同一个 key 下，超过 24 小时视为过期，读写时顺手清理。

const STORAGE_KEY = 'badminton_score_drafts';
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

export interface ScoreDraft {
  scoreA: number;
  scoreB: number;
  savedAt: number;
}

type DraftMap = Record<string, ScoreDraft>;

function isValidDraft(v: unknown, now: number): v is ScoreDraft {
  if (!v || typeof v !== 'object') return false;
  const d = v as ScoreDraft;
  return (
    typeof d.scoreA === 'number' &&
    typeof d.scoreB === 'number' &&
    typeof d.savedAt === 'number' &&
    now - d.savedAt < DRAFT_TTL_MS
  );
}

/** 读取全部草稿并剔除过期/脏数据 */
function readAll(now: number): DraftMap {
  const raw: unknown = Taro.getStorageSync(STORAGE_KEY);
  if (!raw || typeof raw !== 'object') return {};
  const alive: DraftMap = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isValidDraft(value, now)) alive[key] = value;
  }
  return alive;
}

export function loadScoreDraft(matchId: number | string, now = Date.now()): ScoreDraft | null {
  return readAll(now)[String(matchId)] ?? null;
}

export function saveScoreDraft(
  matchId: number | string,
  scoreA: number,
  scoreB: number,
  now = Date.now(),
): void {
  const map = readAll(now);
  map[String(matchId)] = { scoreA, scoreB, savedAt: now };
  Taro.setStorageSync(STORAGE_KEY, map);
}

export function clearScoreDraft(matchId: number | string, now = Date.now()): void {
  const map = readAll(now);
  delete map[String(matchId)];
  Taro.setStorageSync(STORAGE_KEY, map);
}
