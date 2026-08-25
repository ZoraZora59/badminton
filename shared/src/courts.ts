/**
 * 场地编号显示。
 *
 * 分组引擎里的 `courtNo` 恒为 1..N，含义是「第几片场地」；而球馆实际给的是
 * 「5、6、12 号场」。此前看板只显示「场地 1/2/3」，全场每一轮都要在脑子里做一次
 * 映射，每轮都有人走错场。局长可在建局时选填真实编号，此处负责把序号翻成它。
 *
 * 设计上刻意保持「纯展示、可缺省」：不填、填得不够、填了脏数据，都回落成序号，
 * 保证任何时候都有得显示，也不会影响引擎和历史数据。
 */

/** 把「5,6,12」「5、6 12」这类输入切成标签数组；空输入返回空数组 */
export function parseCourtLabels(raw?: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(/[,，、\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 第 courtNo 片场地（1 起）对用户显示成什么；没有对应标签时回落成序号 */
export function courtLabel(raw: string | null | undefined, courtNo: number): string {
  const labels = parseCourtLabels(raw);
  return labels[courtNo - 1] ?? String(courtNo);
}
