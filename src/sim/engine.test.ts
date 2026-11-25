import { describe, expect, it } from 'vitest';
import { runSimulation, SIMULATION_LIMITS } from './engine';
import { baseTopology } from '../data/labs';
import { calculateConvergence, NetworkTopology, validateConfig } from './topology';
import {
  defaultDcqcn,
  defaultDwrr,
  defaultEcn,
  defaultPfc,
  type NetworkConfig,
  type ServerNode,
  type SwitchNode,
} from './types';

function server(kind: 'compute' | 'storage'): ServerNode {
  return {
    id: kind,
    name: kind,
    kind,
    device: 'server',
    x: 0,
    y: 0,
    nic: {
      rateGbps: 100,
      mtuBytes: 9000,
      rocePriority: 3,
      dcqcn: defaultDcqcn(),
      pfc: defaultPfc(),
      dwrr: defaultDwrr(),
    },
    serviceLimitGbps: 100,
  };
}

function leaf(): SwitchNode {
  return {
    id: 'leaf',
    name: 'leaf',
    kind: 'leaf',
    device: 'switch',
    x: 0,
    y: 0,
    switch: {
      bufferPerPortKb: 2048,
      tailDropMode: 'static',
      dynamicAlpha: 0.125,
      staticWatermarkKb: 65_536,
      sharedBufferKb: 0,
      sharedBufferEnabled: false,
      switchingDelayUs: 0.2,
      ecn: defaultEcn(),
      pfc: defaultPfc(),
      dwrr: defaultDwrr(),
    },
  };
}

function config(): NetworkConfig {
  return {
    version: 1,
    name: 'test',
    nodes: [server('compute'), leaf(), server('storage')],
    links: [
      { id: 'compute-leaf', name: 'c-l', source: 'compute', target: 'leaf', rateGbps: 10, propagationUs: 0.5, enabled: true },
      { id: 'leaf-storage', name: 'l-s', source: 'leaf', target: 'storage', rateGbps: 100, propagationUs: 0.5, enabled: true },
    ],
    flows: [{
      id: 'nfs',
      name: 'NFS READ',
      source: 'compute',
      target: 'storage',
      template: 'read-sequential',
      enabled: true,
      fileSizeMb: 1,
      requestSizeKb: 64,
      queueDepth: 32,
      startTimeUs: 0,
      burstIntervalUs: 0,
      burstDurationUs: 0,
      backgroundRateGbps: 0,
      priority: 3,
    }],
    settings: {
      durationUs: 500,
      sampleIntervalUs: 25,
      maxFrameBytes: 9000,
      retransmissionTimeoutUs: 5000,
      randomSeed: 7,
    },
  };
}

function congestedConfig(): NetworkConfig {
  const value = config();
  const sw = value.nodes[1] as SwitchNode;
  sw.switch.ecn.minKb = 8;
  sw.switch.ecn.maxKb = 32;
  sw.switch.ecn.maxProbability = 1;
  sw.switch.pfc.enabled = false;
  for (const node of value.nodes) {
    if (node.device === 'server') {
      node.nic.pfc.enabled = false;
      node.nic.dcqcn.alpha = 0.5;
      node.nic.dcqcn.recoveryIntervalUs = 10_000;
      node.nic.dcqcn.cnpIntervalUs = 1;
    }
  }
  return value;
}

describe('topology validation and convergence', () => {
  it('reports duplicate ids and disconnected enabled flows', () => {
    const value = config();
    value.nodes.push(server('compute'));
    value.links[1].enabled = false;
    const issues = validateConfig(value);
    expect(issues.some((issue) => issue.severity === 'error' && issue.message.includes('重复'))).toBe(true);
    expect(issues.some((issue) => issue.severity === 'error' && issue.flowId === 'nfs')).toBe(true);
  });

  it('calculates enabled Leaf access/uplink bandwidth ratio', () => {
    const value = config();
    const spine: SwitchNode = { ...leaf(), id: 'spine', kind: 'spine' };
    value.nodes = [value.nodes[0], value.nodes[1], value.nodes[2], spine];
    value.links = [
      { id: 'a', name: 'a', source: 'compute', target: 'leaf', rateGbps: 100, propagationUs: 0, enabled: true },
      { id: 'b', name: 'b', source: 'storage', target: 'leaf', rateGbps: 100, propagationUs: 0, enabled: true },
      { id: 'u', name: 'u', source: 'leaf', target: 'spine', rateGbps: 50, propagationUs: 0, enabled: true },
      { id: 'disabled', name: 'd', source: 'compute', target: 'spine', rateGbps: 500, propagationUs: 0, enabled: false },
    ];
    value.flows = [];
    expect(calculateConvergence(value)).toEqual([{
      nodeId: 'leaf', accessGbps: 200, uplinkGbps: 50, ratio: 4, label: '4.00:1',
    }]);
  });

  it('selects the same ECMP path for a flow key', () => {
    const value = config();
    const topology = new NetworkTopology(value);
    expect(topology.route('compute', 'storage', 'flow-a')).toEqual(topology.route('compute', 'storage', 'flow-a'));
  });
});

describe('congestion teaching model', () => {
  it('marks ECN, returns CNP and reduces the DCQCN source rate', async () => {
    const value = congestedConfig();
    const result = await runSimulation(value);
    expect(result.summary.ecnMarks).toBeGreaterThan(0);
    expect(result.summary.cnpCount).toBeGreaterThan(0);
    expect(result.events.some((event) => event.type === 'cnp')).toBe(true);
    expect(result.events.some((event) => event.type === 'rate-down')).toBe(true);
    expect(result.frames.at(-1)?.flows.nfs.rateGbps).toBeLessThan(100);
    expect(result.summary.ecnMarks).toBeGreaterThanOrEqual(result.summary.cnpCount);
  });

  it('is deterministic for the same seed', async () => {
    const first = await runSimulation(congestedConfig());
    const second = await runSimulation(congestedConfig());
    expect(second.summary).toEqual(first.summary);
    expect(second.traces).toEqual(first.traces);
  });

  it('pauses only the configured priority with PFC XOFF/XON', async () => {
    const value = congestedConfig();
    value.flows[0].fileSizeMb = 0.25;
    value.settings.durationUs = 1000;
    const sw = value.nodes[1] as SwitchNode;
    sw.switch.ecn.enabled = false;
    sw.switch.bufferPerPortKb = 64;
    sw.switch.pfc.enabled = true;
    sw.switch.pfc.xoffKb = 8;
    sw.switch.pfc.xonKb = 2;
    sw.switch.pfc.headroomKb = 4;
    for (const node of value.nodes) {
      if (node.device === 'server') {
        node.nic.pfc.enabled = true;
        node.nic.dcqcn.enabled = false;
      }
    }
    const result = await runSimulation(value);
    expect(result.events.some((event) => event.type === 'pfc-on' && event.priority === 3)).toBe(true);
    expect(result.events.some((event) => event.type === 'pfc-off' && event.priority === 3)).toBe(true);
    expect(result.summary.pfcPauses).toBeGreaterThan(0);
    expect(result.summary.pfcBusyUs).toBeGreaterThan(0);
  });

  it.each(['read-sequential', 'write-sequential'] as const)('completes the NFS request/data/ACK loop for %s', async (template) => {
    const value = config();
    value.links[0].rateGbps = 100;
    value.flows[0].template = template;
    value.flows[0].fileSizeMb = 0.125;
    const sw = value.nodes[1] as SwitchNode;
    sw.switch.ecn.enabled = false;
    sw.switch.pfc.enabled = false;
    const result = await runSimulation(value);
    expect(result.summary.completedFlows).toBe(1);
    expect(result.summary.goodputGbps).toBeGreaterThan(0);
    expect(result.frames.at(-1)?.flows.nfs.progress).toBe(1);
    expect(result.events.some((event) => event.type === 'flow-complete')).toBe(true);
  });

  it('drops when buffers are exhausted without PFC and retransmits after RTO', async () => {
    const value = congestedConfig();
    value.settings.durationUs = 150;
    value.settings.retransmissionTimeoutUs = 20;
    value.flows[0].fileSizeMb = 0.25;
    const sw = value.nodes[1] as SwitchNode;
    sw.switch.ecn.enabled = false;
    sw.switch.bufferPerPortKb = 8;
    const result = await runSimulation(value);
    expect(result.summary.drops).toBeGreaterThan(0);
    expect(result.summary.retransmissions).toBeGreaterThan(0);
    expect(result.events.some((event) => event.type === 'retransmit')).toBe(true);
  });
});

describe('synchronized storage Incast regression', () => {
  it('delivers data and produces ECN/CNP feedback instead of a drop-only loop', async () => {
    const value = baseTopology();
    value.settings.durationUs = 10_000;
    const result = await runSimulation(value);
    expect(result.summary.goodputGbps).toBeGreaterThan(0);
    expect(result.summary.ecnMarks).toBeGreaterThan(0);
    expect(result.summary.cnpCount).toBeGreaterThan(0);
    expect(result.events.some((event) => event.type === 'rate-down')).toBe(true);
    expect(result.frames.some((frame) => frame.total.goodputGbps > 0)).toBe(true);
    expect(result.summary.completedFlows).toBeGreaterThan(0);
    expect(result.summary.drops).toBeLessThan(1000);
  }, 15_000);
});

describe('background and cancellation', () => {
  it('models mixed-background as paced background payload with goodput', async () => {
    const value = config();
    value.links[0].rateGbps = 100;
    value.flows[0].template = 'mixed-background';
    value.flows[0].backgroundRateGbps = 20;
    value.settings.durationUs = 200;
    const result = await runSimulation(value);
    expect(result.summary.goodputGbps).toBeGreaterThan(0);
    expect(result.frames.at(-1)?.flows.nfs.deliveredMb).toBeGreaterThan(0);
    expect(result.frames.at(-1)?.flows.nfs.rateGbps).toBe(20);
    expect(result.traces.some((trace) => trace.kind === 'background')).toBe(true);
    expect(result.traces.some((trace) => trace.kind === 'data' || trace.kind === 'control')).toBe(false);
  });

  it('cooperatively returns a marked partial result when cancelled', async () => {
    const result = await runSimulation(congestedConfig(), undefined, () => true);
    expect(result.summary.durationUs).toBe(0);
    expect(result.events.some((event) => event.type === 'warning' && event.message.includes('取消'))).toBe(true);
    expect(result.summary.insights.some((insight) => insight.includes('取消'))).toBe(true);
  });
});

describe('bounded browser workload', () => {
  it('runs the default 8-server/4-switch 50ms topology within output limits', async () => {
    const result = await runSimulation(baseTopology());
    expect(result.frames.length).toBeLessThanOrEqual(SIMULATION_LIMITS.maxMetricFrames);
    expect(result.traces.length).toBeLessThanOrEqual(SIMULATION_LIMITS.maxTraces);
    expect(result.events.length).toBeLessThanOrEqual(SIMULATION_LIMITS.maxKeyEvents);
    expect(result.summary.goodputGbps).toBeGreaterThan(0);
    expect(result.summary.completedFlows).toBe(4);
    for (const frame of result.frames) {
      expect(Number.isFinite(frame.total.offeredGbps)).toBe(true);
      expect(Number.isFinite(frame.total.goodputGbps)).toBe(true);
    }
  }, 15_000);
});
