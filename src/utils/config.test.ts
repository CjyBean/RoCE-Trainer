import { describe, expect, it } from 'vitest';
import { parseNetworkConfig, parseValidNetworkConfig } from './config';
import { baseTopology } from '../data/labs';

describe('配置解析与校验边界', () => {
  it('接受有效拓扑', () => {
    expect(parseValidNetworkConfig(baseTopology()).nodes).toHaveLength(12);
  });

  it('拒绝缺失 settings 的残缺对象', () => {
    expect(() => parseValidNetworkConfig({ version: 1, name: 'x', nodes: [], links: [], flows: [] })).toThrow(/settings/);
  });

  it('拒绝非法的尾丢模式', () => {
    const config = baseTopology();
    (config.nodes[5] as any).switch.tailDropMode = 'bogus';
    expect(() => parseNetworkConfig(config)).toThrow(/tailDropMode/);
  });

  it('拒绝引用不存在节点的链路', () => {
    const config = baseTopology();
    config.links[0].target = 'missing-node';
    expect(() => parseValidNetworkConfig(config)).toThrow();
  });

  it('拒绝 NaN 数值', () => {
    const config = baseTopology();
    config.settings.randomSeed = Number.NaN;
    expect(() => parseNetworkConfig(config)).toThrow(/有限数字/);
  });
});
