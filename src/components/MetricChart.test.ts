import { describe, expect, it } from 'vitest';
import { chartMaxValue, sampleIndices } from './MetricChart';

describe('MetricChart 抽样与最大值为防止参数溢出而实现', () => {
  it('chartMaxValue 不在函数参数中展开全部采样点', () => {
    const values = Array.from({ length: 500_000 }, (_, index) => (index % 997) / 10);
    const max = chartMaxValue([{ id: 'a', label: 'A', color: '#000', values }, { id: 'b', label: 'B', color: '#000', values: [] }]);
    expect(max).toBeGreaterThan(99);
    expect(Number.isFinite(max)).toBe(true);
  });

  it('sampleIndices 始终返回有限数量的等距索引并保留首尾', () => {
    const indices = sampleIndices(1_000_000);
    expect(indices.length).toBeLessThanOrEqual(1200);
    expect(indices[0]).toBe(0);
    expect(indices.at(-1)).toBe(999_999);
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
    expect(sampleIndices(5)).toEqual([0, 1, 2, 3, 4]);
    expect(sampleIndices(0)).toEqual([]);
  });
});
