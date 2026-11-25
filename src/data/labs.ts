import {
  defaultDcqcn,
  defaultDwrr,
  defaultEcn,
  defaultPfc,
  type NetworkConfig,
  type NetworkLink,
  type NetworkNode,
  type NodeKind,
  type Priority,
  type ServerNode,
  type SwitchNode,
  type TrafficFlow,
} from '../sim/types';

export interface LabVariant {
  id: 'problem' | 'fixed';
  label: string;
  description: string;
  apply: (config: NetworkConfig) => void;
}

export interface LabDefinition {
  id: 'pfc-loss' | 'buffer-watermark' | 'ecn-latency';
  index: string;
  title: string;
  shortTitle: string;
  subtitle: string;
  level: '入门' | '进阶' | '诊断';
  steps: string[];
  observations: string[];
  variants: [LabVariant, LabVariant];
  create: () => NetworkConfig;
}

export function cloneConfig(config: NetworkConfig): NetworkConfig {
  return structuredClone(config);
}

export function makeServer(kind: 'compute' | 'storage', index: number, x: number, y: number): ServerNode {
  const prefix = kind === 'compute' ? 'compute' : 'storage';
  return {
    id: `${prefix}-${String(index).padStart(2, '0')}`,
    name: `${kind === 'compute' ? '计算' : '存储'}-${String(index).padStart(2, '0')}`,
    kind,
    device: 'server',
    x,
    y,
    nic: {
      rateGbps: 100,
      mtuBytes: 9000,
      rocePriority: 3,
      dcqcn: defaultDcqcn(),
      pfc: defaultPfc(),
      dwrr: defaultDwrr(),
    },
    serviceLimitGbps: kind === 'storage' ? 400 : 100,
  };
}

export function makeSwitch(kind: 'leaf' | 'spine', index: number, x: number, y: number): SwitchNode {
  return {
    id: `${kind}-${String(index).padStart(2, '0')}`,
    name: `${kind === 'leaf' ? 'Leaf' : 'Spine'}-${String(index).padStart(2, '0')}`,
    kind,
    device: 'switch',
    x,
    y,
    switch: {
      bufferPerPortKb: 512,
      sharedBufferKb: 8192,
      sharedBufferEnabled: true,
      tailDropMode: 'static',
      dynamicAlpha: 0.125,
      staticWatermarkKb: 65_536,
      switchingDelayUs: 0.8,
      ecn: defaultEcn(),
      pfc: defaultPfc(),
      dwrr: defaultDwrr(),
    },
  };
}

export function createDevice(kind: NodeKind, x: number, y: number, existing: NetworkNode[]): NetworkNode {
  const usedIds = new Set(existing.map((node) => node.id));
  let index = 1;
  while (usedIds.has(`${kind}-${String(index).padStart(2, '0')}`)) index += 1;
  return kind === 'compute' || kind === 'storage'
    ? makeServer(kind, index, x, y)
    : makeSwitch(kind, index, x, y);
}

export function makeLink(id: string, source: string, target: string, rateGbps = 100): NetworkLink {
  return { id, name: id.replace('link-', '').toUpperCase(), source, target, rateGbps, propagationUs: 0.5, enabled: true };
}

export function createLink(source: string, target: string, existing: NetworkLink[]): NetworkLink {
  let index = existing.length + 1;
  while (existing.some((link) => link.id === `link-${index}`)) index += 1;
  return { ...makeLink(`link-${index}`, source, target), name: `100GE0/0/${index}` };
}

function flows(incast: boolean): TrafficFlow[] {
  return Array.from({ length: 4 }, (_, index): TrafficFlow => ({
    id: `flow-${index + 1}`,
    name: `NFS 微突发读 ${index + 1}`,
    source: `compute-${String(index + 1).padStart(2, '0')}`,
    target: incast ? 'storage-01' : `storage-${String(index + 1).padStart(2, '0')}`,
    template: 'read-microburst',
    enabled: true,
    fileSizeMb: 4,
    requestSizeKb: 256,
    queueDepth: 16,
    startTimeUs: 1000,
    burstIntervalUs: 5000,
    burstDurationUs: 600,
    backgroundRateGbps: 0,
    priority: 3,
  }));
}

export function baseTopology(): NetworkConfig {
  const nodes: NetworkNode[] = [
    ...Array.from({ length: 4 }, (_, i) => makeServer('compute', i + 1, 105, 80 + i * 115)),
    makeSwitch('leaf', 1, 330, 252),
    makeSwitch('spine', 1, 500, 142),
    makeSwitch('spine', 2, 500, 362),
    makeSwitch('leaf', 2, 670, 252),
    ...Array.from({ length: 4 }, (_, i) => makeServer('storage', i + 1, 895, 80 + i * 115)),
  ];
  const links: NetworkLink[] = [];
  for (let i = 1; i <= 4; i += 1) {
    links.push(makeLink(`link-c${i}-l1`, `compute-${String(i).padStart(2, '0')}`, 'leaf-01'));
    links.push(makeLink(`link-l2-s${i}`, 'leaf-02', `storage-${String(i).padStart(2, '0')}`));
  }
  links.push(
    makeLink('link-l1-sp1', 'leaf-01', 'spine-01'),
    makeLink('link-l1-sp2', 'leaf-01', 'spine-02'),
    makeLink('link-sp1-l2', 'spine-01', 'leaf-02'),
    makeLink('link-sp2-l2', 'spine-02', 'leaf-02'),
  );
  links.forEach((link, index) => { link.name = `100GE0/0/${index + 1}`; });
  return {
    version: 1,
    name: 'RoCEv2 无损教学拓扑',
    nodes,
    links,
    flows: flows(true),
    settings: { durationUs: 50_000, sampleIntervalUs: 100, maxFrameBytes: 9000, retransmissionTimeoutUs: 500, randomSeed: 42 },
  };
}

function eachServer(config: NetworkConfig, update: (node: ServerNode) => void) {
  config.nodes.filter((node): node is ServerNode => node.device === 'server').forEach(update);
}

function eachSwitch(config: NetworkConfig, update: (node: SwitchNode) => void) {
  config.nodes.filter((node): node is SwitchNode => node.device === 'switch').forEach(update);
}

function setPfc(config: NetworkConfig, enabled: boolean) {
  eachServer(config, (node) => { node.nic.pfc.enabled = enabled; });
  eachSwitch(config, (node) => { node.switch.pfc.enabled = enabled; });
}

function setEcn(config: NetworkConfig, enabled: boolean) {
  eachSwitch(config, (node) => { node.switch.ecn.enabled = enabled; });
}

function setDcqcn(config: NetworkConfig, enabled: boolean) {
  eachServer(config, (node) => { node.nic.dcqcn.enabled = enabled; });
}

function setUplinkRate(config: NetworkConfig, rate: number) {
  const uplinks = new Set(['link-l1-sp1', 'link-l1-sp2', 'link-sp1-l2', 'link-sp2-l2']);
  config.links.forEach((link) => { if (uplinks.has(link.id)) link.rateGbps = rate; });
}

function preparePfc(config: NetworkConfig, enabled: boolean) {
  config.flows = flows(false);
  config.settings.durationUs = 50_000;
  config.settings.retransmissionTimeoutUs = 5000;
  setUplinkRate(config, 50);
  eachSwitch(config, (node) => {
    node.switch.bufferPerPortKb = 128;
    node.switch.sharedBufferKb = 512;
    node.switch.sharedBufferEnabled = true;
    node.switch.tailDropMode = 'static';
    node.switch.staticWatermarkKb = 1024;
    node.switch.dynamicAlpha = 0.03;
    node.switch.ecn.enabled = true;
    node.switch.ecn.minKb = 32;
    node.switch.ecn.maxKb = 96;
    node.switch.pfc.xoffKb = 64;
    node.switch.pfc.xonKb = 32;
    node.switch.pfc.headroomKb = 64;
  });
  eachServer(config, (node) => {
    node.nic.dcqcn.enabled = false;
    node.nic.dcqcn.initialRateGbps = 100;
    node.nic.dcqcn.maxRateGbps = 100;
    node.nic.dcqcn.minRateGbps = 1;
    node.nic.pfc.xoffKb = 64;
    node.nic.pfc.xonKb = 32;
    node.nic.pfc.headroomKb = 64;
  });
  setEcn(config, false);
  setDcqcn(config, false);
  setPfc(config, true);
  if (!enabled) setPfc(config, false);
}

function prepareBuffer(config: NetworkConfig, mode: 'dynamic' | 'static') {
  config.flows = flows(false);
  config.flows.forEach((flow) => {
    flow.fileSizeMb = 2;
    flow.requestSizeKb = 256;
    flow.queueDepth = 8;
    flow.burstIntervalUs = 5000;
    flow.burstDurationUs = 200;
  });
  config.settings.durationUs = 50_000;
  config.settings.retransmissionTimeoutUs = 5000;
  setUplinkRate(config, 50);
  setPfc(config, false);
  setEcn(config, false);
  setDcqcn(config, false);
  eachSwitch(config, (node) => {
    node.switch.bufferPerPortKb = 512;
    node.switch.sharedBufferKb = 32_768;
    node.switch.sharedBufferEnabled = true;
    node.switch.dynamicAlpha = 0.01;
    node.switch.staticWatermarkKb = 16_384;
    node.switch.tailDropMode = mode;
  });
}

function prepareEcn(config: NetworkConfig, highWatermark: boolean) {
  config.flows = flows(false);
  config.flows.forEach((flow) => {
    flow.fileSizeMb = 64;
    flow.requestSizeKb = 4096;
    flow.queueDepth = 4;
    flow.burstIntervalUs = 5000;
    flow.burstDurationUs = 200;
  });
  config.settings.durationUs = 500_000;
  config.settings.retransmissionTimeoutUs = 200_000;
  config.settings.maxFrameBytes = 65_536;
  setUplinkRate(config, 100);
  setPfc(config, true);
  setEcn(config, true);
  eachServer(config, (node) => {
    node.nic.dcqcn.enabled = true;
    node.nic.dcqcn.initialRateGbps = 100;
    node.nic.dcqcn.minRateGbps = 1;
    node.nic.dcqcn.maxRateGbps = 100;
    node.nic.dcqcn.alpha = 0.2;
    node.nic.dcqcn.alphaGain = 0.5;
    node.nic.dcqcn.rateIncreaseGbps = 1;
    node.nic.dcqcn.recoveryIntervalUs = 2000;
    node.nic.dcqcn.cnpIntervalUs = 20;
    node.nic.pfc.xoffKb = 16_384;
    node.nic.pfc.xonKb = 8192;
    node.nic.pfc.headroomKb = 2048;
  });
  eachSwitch(config, (node) => {
    node.switch.bufferPerPortKb = 32_768;
    node.switch.sharedBufferKb = 131_072;
    node.switch.sharedBufferEnabled = true;
    node.switch.tailDropMode = 'static';
    node.switch.staticWatermarkKb = 65_536;
    node.switch.dynamicAlpha = 0.125;
    node.switch.ecn.minKb = highWatermark ? 1024 : 8;
    node.switch.ecn.maxKb = highWatermark ? 2048 : 32;
    node.switch.ecn.maxProbability = 1;
    node.switch.pfc.xoffKb = 16_384;
    node.switch.pfc.xonKb = 8192;
    node.switch.pfc.headroomKb = 2048;
  });
}

const pfcVariants: [LabVariant, LabVariant] = [
  { id: 'problem', label: '问题：端口 PFC 未开启', description: '交换机上行端口的 RoCE 优先级失去最后保护，观察丢包和 RTO 重传。', apply: (config) => preparePfc(config, false) },
  { id: 'fixed', label: '修复：开启 PFC', description: '只恢复交换机上行端口及服务端网卡的 PFC，其他业务和水线保持不变。', apply: (config) => preparePfc(config, true) },
];

const bufferVariants: [LabVariant, LabVariant] = [
  { id: 'problem', label: '问题：shared dynamic', description: '动态水线随共享池剩余空间收紧，突发超过水线后发生尾丢。', apply: (config) => prepareBuffer(config, 'dynamic') },
  { id: 'fixed', label: '修复：static 水线', description: '改为 16 MiB 固定尾丢水线，让共享内存吸收同一轮微突发。', apply: (config) => prepareBuffer(config, 'static') },
];

const ecnVariants: [LabVariant, LabVariant] = [
  { id: 'problem', label: '问题：ECN 8–32 KiB', description: '水线过低，CNP 频繁反馈，DCQCN 反复降速，NFS 操作时延升高。', apply: (config) => prepareEcn(config, false) },
  { id: 'fixed', label: '修复：ECN 1024–2048 KiB', description: '提高 ECN 水线，减少不必要的降速；业务模型和其他参数保持不变。', apply: (config) => prepareEcn(config, true) },
];

export const LABS: LabDefinition[] = [
  {
    id: 'pfc-loss', index: '01', title: 'PFC 未开启导致丢包与重传', shortTitle: 'PFC 丢包与修复',
    subtitle: '对比存储接入端口关闭和开启 PFC 后的同一轮 RoCE 微突发。', level: '入门',
    steps: ['先运行“端口 PFC 未开启”，观察丢包和 RTO 重传。', '切换“开启 PFC”并再次运行。', '对比丢包、重传与 NFS 完成时延。'],
    observations: ['PFC 按优先级暂停，不是停掉整个端口。', '修复目标是本轮突发不再因缓冲耗尽而丢包。'],
    variants: pfcVariants, create: () => { const config = baseTopology(); preparePfc(config, false); return config; },
  },
  {
    id: 'buffer-watermark', index: '02', title: '共享内存与尾丢水线', shortTitle: 'Dynamic / Static 水线',
    subtitle: '关闭 ECN 和 PFC，只比较 shared dynamic 与 static 尾丢水线。', level: '进阶',
    steps: ['运行 shared dynamic，定位共享内存突发丢包。', '切换 static 水线并运行相同流量。', '对比队列高水位、丢包和重传。'],
    observations: ['static 水线不是增加物理内存，而是允许端口使用更多共享缓冲。', '若突发持续超过出口能力，再大的水线也只能延迟丢包。'],
    variants: bufferVariants, create: () => { const config = baseTopology(); prepareBuffer(config, 'dynamic'); return config; },
  },
  {
    id: 'ecn-latency', index: '03', title: 'ECN 水线过低放大微突发时延', shortTitle: 'ECN 水线与时延',
    subtitle: '多轮 NFS 微突发下，只调整 ECN 水线，观察 DCQCN 与 P95 时延。', level: '诊断',
    steps: ['运行 8–32 KiB 低水线，观察 ECN/CNP 和 P95 时延。', '切换 1024–2048 KiB 高水线并再次运行。', '对比 ECN 次数、P95 时延和 Goodput。'],
    observations: ['过低水线可能造成过度降速和链路利用率不足。', '水线也不是越高越好，应同时检查队列、PFC 和丢包。'],
    variants: ecnVariants, create: () => { const config = baseTopology(); prepareEcn(config, false); return config; },
  },
];

export const TRAFFIC_TEMPLATE_NAMES: Record<TrafficFlow['template'], string> = {
  'read-sequential': 'NFS 顺序读',
  'write-sequential': 'NFS 顺序写',
  'read-microburst': 'NFS 同步读突发',
  'write-microburst': 'NFS 同步写突发',
  'mixed-background': '背景数据流',
};

export function applyVariant(config: NetworkConfig, lab: LabDefinition, variantId: string): NetworkConfig {
  const next = cloneConfig(config);
  lab.variants.find((variant) => variant.id === variantId)?.apply(next);
  return next;
}

export function priorityLabel(priority: Priority): string {
  if (priority === 7) return 'CNP';
  if (priority === 6) return 'ACK / 控制';
  if (priority === 3) return 'RoCE 数据';
  if (priority === 0) return '背景业务';
  return `优先级 ${priority}`;
}
