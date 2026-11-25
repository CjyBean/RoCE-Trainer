export function formatTime(us: number): string {
  if (us < 1000) return `${us.toFixed(us < 10 ? 1 : 0)} µs`;
  if (us < 1_000_000) return `${(us / 1000).toFixed(us < 10_000 ? 2 : 1)} ms`;
  return `${(us / 1_000_000).toFixed(2)} s`;
}

export function formatNumber(value: number, digits = 0): string {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: digits }).format(value);
}

export function formatGbps(value: number): string {
  if (value >= 100) return `${value.toFixed(0)}G`;
  if (value >= 10) return `${value.toFixed(1)}G`;
  return `${value.toFixed(2)}G`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export const EVENT_NAMES: Record<string, string> = {
  ecn: 'ECN 标记',
  cnp: 'CNP 反馈',
  'pfc-on': 'PFC 暂停',
  'pfc-off': 'PFC 恢复',
  drop: '队列丢包',
  retransmit: '业务重传',
  'rate-down': 'DCQCN 降速',
  'rate-up': 'DCQCN 恢复',
  'flow-start': '业务开始',
  'flow-complete': '业务完成',
  warning: '配置预警',
};
