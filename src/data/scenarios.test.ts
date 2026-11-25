import { describe, expect, it } from 'vitest';
import { LABS, applyVariant, type LabDefinition } from './labs';
import { runSimulation } from '../sim/engine';
import type { NetworkConfig, SimulationResult } from '../sim/types';

function lab(id: LabDefinition['id']): LabDefinition {
  return LABS.find((item) => item.id === id)!;
}

async function runVariant(definition: LabDefinition, variantId: 'problem' | 'fixed'): Promise<{ config: NetworkConfig; result: SimulationResult }> {
  const config = applyVariant(definition.create(), definition, variantId);
  const result = await runSimulation(config);
  expect(result.frames.length).toBeGreaterThan(2);
  return { config, result };
}

describe('三个故障—修复教学场景', () => {
  it('端口 PFC 未开启导致丢包和重传，恢复 PFC 后解决', async () => {
    const definition = lab('pfc-loss');
    const problem = await runVariant(definition, 'problem');
    const fixed = await runVariant(definition, 'fixed');
    expect(problem.result.summary.drops).toBeGreaterThan(0);
    expect(problem.result.summary.retransmissions).toBeGreaterThan(0);
    expect(fixed.result.summary.drops).toBe(0);
    expect(fixed.result.summary.retransmissions).toBe(0);
    expect(fixed.result.summary.completedFlows).toBe(4);
  }, 60_000);

  it('dynamic 水线发生尾丢，static 水线吸收相同突发', async () => {
    const definition = lab('buffer-watermark');
    const problem = await runVariant(definition, 'problem');
    const fixed = await runVariant(definition, 'fixed');
    expect(problem.config.flows).toEqual(fixed.config.flows);
    expect(problem.result.summary.drops).toBeGreaterThan(0);
    expect(problem.result.summary.retransmissions).toBeGreaterThan(0);
    expect(fixed.result.summary.drops).toBe(0);
    expect(fixed.result.summary.retransmissions).toBe(0);
    expect(fixed.result.summary.peakQueueKb).toBeGreaterThan(512);
  }, 60_000);

  it('ECN 低水线更频繁降速并产生更高 NFS 时延，提高水线后改善', async () => {
    const definition = lab('ecn-latency');
    const problem = await runVariant(definition, 'problem');
    const fixed = await runVariant(definition, 'fixed');
    expect(problem.config.flows).toEqual(fixed.config.flows);
    expect(problem.result.summary.ecnMarks).toBeGreaterThan(fixed.result.summary.ecnMarks);
    expect(problem.result.summary.averageRttUs).toBeGreaterThan(0);
    expect(problem.result.summary.p95RttUs).toBeGreaterThan(fixed.result.summary.p95RttUs);
    expect(problem.result.summary.p95RttUs).toBeGreaterThanOrEqual(20_000);
    expect(fixed.result.summary.p95RttUs).toBeLessThan(problem.result.summary.p95RttUs);
    expect(problem.result.summary.completedFlows).toBe(4);
    expect(fixed.result.summary.completedFlows).toBe(4);
    expect(problem.result.summary.insights.join(' ')).not.toContain('截断');
    expect(fixed.result.summary.insights.join(' ')).not.toContain('截断');
  }, 120_000);
});
