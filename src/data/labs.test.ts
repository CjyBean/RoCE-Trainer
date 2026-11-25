import { describe, expect, it } from 'vitest';
import { LABS, applyVariant, baseTopology, cloneConfig, createDevice } from './labs';
import { executeCommand } from '../cli/parser';
import type { ServerNode, SwitchNode } from '../sim/types';

function expectReferencesValid(config: ReturnType<typeof baseTopology>) {
  const nodeIds = new Set(config.nodes.map((node) => node.id));
  expect(nodeIds.size).toBe(config.nodes.length);
  config.links.forEach((link) => {
    expect(nodeIds.has(link.source)).toBe(true);
    expect(nodeIds.has(link.target)).toBe(true);
  });
  config.flows.forEach((flow) => {
    expect(nodeIds.has(flow.source)).toBe(true);
    expect(nodeIds.has(flow.target)).toBe(true);
    expect(flow.source).not.toBe(flow.target);
  });
}

describe('三个内置教学实验', () => {
  it('只提供三个故障—修复场景，每个有两个变体', () => {
    expect(LABS.map((lab) => lab.id)).toEqual(['pfc-loss', 'buffer-watermark', 'ecn-latency']);
    LABS.forEach((lab) => {
      expect(lab.variants.map((variant) => variant.id)).toEqual(['problem', 'fixed']);
      expectReferencesValid(lab.create());
    });
  });

  it('默认拓扑是 8 服务器、4 交换机的双平面 Leaf-Spine', () => {
    const config = baseTopology();
    expect(config.nodes.filter((node) => node.device === 'server')).toHaveLength(8);
    expect(config.nodes.filter((node) => node.device === 'switch')).toHaveLength(4);
    expect(config.links).toHaveLength(12);
    expectReferencesValid(config);
  });

  it('PFC 场景仅改变目标端口的 PFC 状态', () => {
    const lab = LABS[0];
    const problem = applyVariant(lab.create(), lab, 'problem');
    const fixed = applyVariant(lab.create(), lab, 'fixed');
    expect(problem.flows).toEqual(fixed.flows);
    const problemStorage = problem.nodes.find((node): node is ServerNode => node.id === 'storage-01')!;
    const fixedStorage = fixed.nodes.find((node): node is ServerNode => node.id === 'storage-01')!;
    expect(problemStorage.nic.pfc.enabled).toBe(false);
    expect(fixedStorage.nic.pfc.enabled).toBe(true);
    expect(problemStorage.nic.dcqcn).toEqual(fixedStorage.nic.dcqcn);
    problem.nodes.filter((node): node is SwitchNode => node.device === 'switch').forEach((node) => {
      expect(node.switch.pfc.enabled).toBe(false);
      expect(node.switch.ecn.enabled).toBe(false);
    });
    fixed.nodes.filter((node): node is SwitchNode => node.device === 'switch').forEach((node) => {
      expect(node.switch.pfc.enabled).toBe(true);
    });
  });

  it('水线场景保持业务不变并隔离 ECN/PFC/DCQCN', () => {
    const lab = LABS[1];
    const problem = applyVariant(lab.create(), lab, 'problem');
    const fixed = applyVariant(lab.create(), lab, 'fixed');
    expect(problem.flows).toEqual(fixed.flows);
    problem.nodes.filter((node): node is SwitchNode => node.device === 'switch').forEach((node) => {
      expect(node.switch.tailDropMode).toBe('dynamic');
      expect(node.switch.ecn.enabled).toBe(false);
      expect(node.switch.pfc.enabled).toBe(false);
    });
    fixed.nodes.filter((node): node is SwitchNode => node.device === 'switch').forEach((node) => {
      expect(node.switch.tailDropMode).toBe('static');
      expect(node.switch.staticWatermarkKb).toBe(16_384);
    });
    problem.nodes.filter((node): node is ServerNode => node.device === 'server').forEach((node) => {
      expect(node.nic.dcqcn.enabled).toBe(false);
    });
  });

  it('ECN 场景保持业务与 DCQCN 不变，仅改变水线', () => {
    const lab = LABS[2];
    const problem = applyVariant(lab.create(), lab, 'problem');
    const fixed = applyVariant(lab.create(), lab, 'fixed');
    expect(problem.flows).toEqual(fixed.flows);
    const low = problem.nodes.find((node): node is SwitchNode => node.id === 'leaf-01')!;
    const high = fixed.nodes.find((node): node is SwitchNode => node.id === 'leaf-01')!;
    expect(low.switch.ecn.minKb).toBe(8);
    expect(high.switch.ecn.minKb).toBe(1024);
    expect(low.switch.pfc).toEqual(high.switch.pfc);
    const problemStorage = problem.nodes.find((node): node is ServerNode => node.id === 'storage-01')!;
    const fixedStorage = fixed.nodes.find((node): node is ServerNode => node.id === 'storage-01')!;
    expect(problemStorage.nic.dcqcn).toEqual(fixedStorage.nic.dcqcn);
  });

  it('删除中间设备后新增设备不会复用已有 ID', () => {
    const config = baseTopology();
    const remaining = config.nodes.filter((node) => node.id !== 'compute-02');
    const created = createDevice('compute', 100, 100, remaining);
    expect(created.id).toBe('compute-02');
    const another = createDevice('compute', 100, 100, [...remaining, created]);
    expect(another.id).toBe('compute-05');
  });

  it('默认接口名可直接用于 CE 风格 CLI 并双向修改链路', () => {
    const original = baseTopology();
    const before = cloneConfig(original);
    const link = original.links.find((item) => item.source === 'leaf-01')!;
    const response = executeCommand(original, 'leaf-01', `interface ${link.name}\nrate 40`);
    expect(response.success).toBe(true);
    expect(response.config.links.find((item) => item.id === link.id)?.rateGbps).toBe(40);
    expect(original).toEqual(before);
  });
});
