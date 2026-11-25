import {
  PRIORITIES,
  type ConvergenceInfo,
  type DcqcnConfig,
  type DwrrConfig,
  type EcnConfig,
  type NetworkConfig,
  type NetworkLink,
  type NetworkNode,
  type PfcConfig,
  type Priority,
  type ValidationIssue,
} from './types';

export interface NetworkRoute {
  /** Nodes in visiting order, including both endpoints. */
  nodeIds: string[];
  /** Physical link ids in visiting order. */
  linkIds: string[];
}

export interface TopologyEdge {
  link: NetworkLink;
  from: string;
  to: string;
}

const KB = 1024;
const MAX_ECMP_PATHS = 128;

function finite(value: number): boolean {
  return Number.isFinite(value);
}

function positive(value: number): boolean {
  return finite(value) && value > 0;
}

function nonNegative(value: number): boolean {
  return finite(value) && value >= 0;
}

function isPriority(value: number): value is Priority {
  return Number.isInteger(value) && value >= 0 && value <= 7;
}

function validatePriorities(
  priorities: Priority[],
  owner: string,
  issues: ValidationIssue[],
  nodeId?: string,
): void {
  const seen = new Set<number>();
  for (const priority of priorities) {
    if (!isPriority(priority)) {
      issues.push({ severity: 'error', nodeId, message: `${owner} 包含无效优先级 ${priority}。` });
    } else if (seen.has(priority)) {
      issues.push({ severity: 'warning', nodeId, message: `${owner} 中优先级 ${priority} 重复。` });
    }
    seen.add(priority);
  }
}

function validatePfc(pfc: PfcConfig, nodeId: string, issues: ValidationIssue[]): void {
  validatePriorities(pfc.priorities, 'PFC', issues, nodeId);
  if (!nonNegative(pfc.xoffKb) || !nonNegative(pfc.xonKb) || pfc.xonKb >= pfc.xoffKb) {
    issues.push({ severity: 'error', nodeId, message: 'PFC 必须满足 0 ≤ XON < XOFF。' });
  }
  if (!nonNegative(pfc.headroomKb)) {
    issues.push({ severity: 'error', nodeId, message: 'PFC headroom 必须是非负有限数。' });
  }
}

function validateEcn(ecn: EcnConfig, nodeId: string, issues: ValidationIssue[]): void {
  validatePriorities(ecn.priorities, 'ECN', issues, nodeId);
  if (!nonNegative(ecn.minKb) || !positive(ecn.maxKb) || ecn.minKb >= ecn.maxKb) {
    issues.push({ severity: 'error', nodeId, message: 'ECN 必须满足 0 ≤ min < max。' });
  }
  if (!finite(ecn.maxProbability) || ecn.maxProbability <= 0 || ecn.maxProbability > 1) {
    issues.push({ severity: 'error', nodeId, message: 'ECN 最大标记概率必须在 (0, 1] 内。' });
  }
}

function validateDwrr(dwrr: DwrrConfig, nodeId: string, issues: ValidationIssue[]): void {
  let sum = 0;
  for (const priority of PRIORITIES) {
    const weight = dwrr.weights[priority];
    if (!nonNegative(weight)) {
      issues.push({ severity: 'error', nodeId, message: `DWRR 优先级 ${priority} 权重必须是非负有限数。` });
    } else {
      sum += weight;
    }
  }
  if (dwrr.enabled && sum <= 0) {
    issues.push({ severity: 'error', nodeId, message: '启用 DWRR 时至少一个优先级权重必须大于 0。' });
  }
}

function validateDcqcn(dcqcn: DcqcnConfig, nodeId: string, issues: ValidationIssue[]): void {
  if (!positive(dcqcn.minRateGbps) || !positive(dcqcn.maxRateGbps) || dcqcn.minRateGbps > dcqcn.maxRateGbps) {
    issues.push({ severity: 'error', nodeId, message: 'DCQCN 必须满足 0 < minRate ≤ maxRate。' });
  }
  if (!positive(dcqcn.initialRateGbps)) {
    issues.push({ severity: 'error', nodeId, message: 'DCQCN 初始速率必须是正有限数。' });
  } else if (dcqcn.initialRateGbps < dcqcn.minRateGbps || dcqcn.initialRateGbps > dcqcn.maxRateGbps) {
    issues.push({ severity: 'warning', nodeId, message: 'DCQCN 初始速率超出 [minRate, maxRate]，仿真时会钳位。' });
  }
  if (!finite(dcqcn.alpha) || dcqcn.alpha < 0 || dcqcn.alpha > 1) {
    issues.push({ severity: 'error', nodeId, message: 'DCQCN alpha 必须在 [0, 1] 内。' });
  }
  if (!finite(dcqcn.alphaGain) || dcqcn.alphaGain <= 0 || dcqcn.alphaGain > 1) {
    issues.push({ severity: 'error', nodeId, message: 'DCQCN alphaGain 必须在 (0, 1] 内。' });
  }
  if (!nonNegative(dcqcn.rateIncreaseGbps)) {
    issues.push({ severity: 'error', nodeId, message: 'DCQCN 恢复步长必须是非负有限数。' });
  }
  if (!positive(dcqcn.recoveryIntervalUs) || !positive(dcqcn.cnpIntervalUs)) {
    issues.push({ severity: 'error', nodeId, message: 'DCQCN 恢复和 CNP 间隔必须是正有限数。' });
  }
}

function validateNode(node: NetworkNode, issues: ValidationIssue[]): void {
  if (node.device === 'server') {
    if (node.kind !== 'compute' && node.kind !== 'storage') {
      issues.push({ severity: 'error', nodeId: node.id, message: '服务器类型必须是 compute 或 storage。' });
    }
    if (!positive(node.nic.rateGbps) || !positive(node.serviceLimitGbps)) {
      issues.push({ severity: 'error', nodeId: node.id, message: 'NIC 速率和服务速率必须是正有限数。' });
    }
    if (!positive(node.nic.mtuBytes) || node.nic.mtuBytes < 576) {
      issues.push({ severity: 'error', nodeId: node.id, message: 'NIC MTU 必须是不小于 576 的有限数。' });
    }
    if (!isPriority(node.nic.rocePriority)) {
      issues.push({ severity: 'error', nodeId: node.id, message: 'NIC RoCE 优先级无效。' });
    }
    validatePfc(node.nic.pfc, node.id, issues);
    validateDwrr(node.nic.dwrr, node.id, issues);
    validateDcqcn(node.nic.dcqcn, node.id, issues);
    return;
  }

  if (node.kind !== 'leaf' && node.kind !== 'spine') {
    issues.push({ severity: 'error', nodeId: node.id, message: '交换机类型必须是 leaf 或 spine。' });
  }
  if (!positive(node.switch.bufferPerPortKb) || !nonNegative(node.switch.sharedBufferKb)) {
    issues.push({ severity: 'error', nodeId: node.id, message: '交换机端口缓冲必须为正，共享缓冲不能为负。' });
  }
  if (!nonNegative(node.switch.switchingDelayUs)) {
    issues.push({ severity: 'error', nodeId: node.id, message: '交换时延必须是非负有限数。' });
  }
  if (node.switch.tailDropMode !== 'dynamic' && node.switch.tailDropMode !== 'static') {
    issues.push({ severity: 'error', nodeId: node.id, message: '尾丢模式必须是 shared dynamic 或 static。' });
  }
  if (!nonNegative(node.switch.dynamicAlpha) || node.switch.dynamicAlpha > 16) {
    issues.push({ severity: 'error', nodeId: node.id, message: 'dynamic Alpha 必须在 [0, 16] 内。' });
  }
  if (!positive(node.switch.staticWatermarkKb)) {
    issues.push({ severity: 'error', nodeId: node.id, message: 'static 尾丢水线必须是正有限数。' });
  }
  validatePfc(node.switch.pfc, node.id, issues);
  validateEcn(node.switch.ecn, node.id, issues);
  validateDwrr(node.switch.dwrr, node.id, issues);
  const totalBuffer = node.switch.bufferPerPortKb + (node.switch.sharedBufferEnabled ? node.switch.sharedBufferKb : 0);
  if (node.switch.pfc.enabled && node.switch.pfc.xoffKb + node.switch.pfc.headroomKb > totalBuffer) {
    issues.push({ severity: 'warning', nodeId: node.id, message: 'PFC XOFF + headroom 超过可用缓冲，可能在暂停生效前丢包。' });
  }
  if (node.switch.ecn.enabled && node.switch.ecn.maxKb > totalBuffer) {
    issues.push({ severity: 'warning', nodeId: node.id, message: 'ECN max 门限高于端口可用缓冲，可能先发生尾丢弃。' });
  }
}

/** Validate structural invariants and parameter ranges without mutating the config. */
export function validateConfig(config: NetworkConfig): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (config.version !== 1) {
    issues.push({ severity: 'error', message: `不支持的配置版本 ${String(config.version)}。` });
  }
  if (!config.nodes.length) {
    issues.push({ severity: 'error', message: '拓扑至少需要一个节点。' });
  }

  const nodes = new Map<string, NetworkNode>();
  for (const node of config.nodes) {
    if (!node.id.trim()) {
      issues.push({ severity: 'error', message: '节点 id 不能为空。' });
      continue;
    }
    if (nodes.has(node.id)) {
      issues.push({ severity: 'error', nodeId: node.id, message: `节点 id ${node.id} 重复。` });
      continue;
    }
    nodes.set(node.id, node);
    validateNode(node, issues);
  }

  if (![...nodes.values()].some((node) => node.kind === 'compute')) {
    issues.push({ severity: 'warning', message: '拓扑中没有计算节点。' });
  }
  if (![...nodes.values()].some((node) => node.kind === 'storage')) {
    issues.push({ severity: 'warning', message: '拓扑中没有存储节点。' });
  }

  const links = new Map<string, NetworkLink>();
  for (const link of config.links) {
    if (!link.id.trim()) {
      issues.push({ severity: 'error', message: '链路 id 不能为空。' });
      continue;
    }
    if (links.has(link.id)) {
      issues.push({ severity: 'error', linkId: link.id, message: `链路 id ${link.id} 重复。` });
      continue;
    }
    links.set(link.id, link);
    if (!nodes.has(link.source) || !nodes.has(link.target)) {
      issues.push({ severity: 'error', linkId: link.id, message: '链路端点必须引用已存在的节点。' });
    }
    if (link.source === link.target) {
      issues.push({ severity: 'error', linkId: link.id, message: '链路不能连接节点自身。' });
    }
    if (!positive(link.rateGbps) || !nonNegative(link.propagationUs)) {
      issues.push({ severity: 'error', linkId: link.id, message: '链路速率必须为正，传播时延必须是非负有限数。' });
    }
    const source = nodes.get(link.source);
    const target = nodes.get(link.target);
    if (source?.device === 'server' && target?.device === 'server') {
      issues.push({ severity: 'warning', linkId: link.id, message: '服务器直连可用于教学，但不是典型 Leaf-Spine 接入。' });
    }
    if (source?.kind === 'spine' && target?.kind === 'spine') {
      issues.push({ severity: 'warning', linkId: link.id, message: 'Spine-Spine 链路不是典型两级 Clos 结构。' });
    }
  }

  const flows = new Set<string>();
  const topology = new NetworkTopology(config);
  for (const flow of config.flows) {
    if (!flow.id.trim()) {
      issues.push({ severity: 'error', message: '业务流 id 不能为空。' });
      continue;
    }
    if (flows.has(flow.id)) {
      issues.push({ severity: 'error', flowId: flow.id, message: `业务流 id ${flow.id} 重复。` });
      continue;
    }
    flows.add(flow.id);
    const source = nodes.get(flow.source);
    const target = nodes.get(flow.target);
    if (!source || !target) {
      issues.push({ severity: 'error', flowId: flow.id, message: '业务流端点必须引用已存在的节点。' });
      continue;
    }
    if (source.id === target.id || source.device !== 'server' || target.device !== 'server') {
      issues.push({ severity: 'error', flowId: flow.id, message: '业务流必须连接两个不同的服务器。' });
    } else if (!((source.kind === 'compute' && target.kind === 'storage') || (source.kind === 'storage' && target.kind === 'compute'))) {
      issues.push({ severity: 'error', flowId: flow.id, message: 'NFS 业务流必须连接一个计算节点和一个存储节点。' });
    }
    if (!nonNegative(flow.fileSizeMb) || !positive(flow.requestSizeKb)) {
      issues.push({ severity: 'error', flowId: flow.id, message: '文件大小不能为负，NFS 请求大小必须为正有限数。' });
    }
    if (!Number.isInteger(flow.queueDepth) || flow.queueDepth <= 0) {
      issues.push({ severity: 'error', flowId: flow.id, message: 'queueDepth 必须是正整数。' });
    }
    if (!nonNegative(flow.startTimeUs) || !nonNegative(flow.burstIntervalUs) || !nonNegative(flow.burstDurationUs)) {
      issues.push({ severity: 'error', flowId: flow.id, message: '业务开始时间、突发间隔和时长必须是非负有限数。' });
    }
    if (!nonNegative(flow.backgroundRateGbps)) {
      issues.push({ severity: 'error', flowId: flow.id, message: '背景流速率必须是非负有限数。' });
    }
    if (!isPriority(flow.priority)) {
      issues.push({ severity: 'error', flowId: flow.id, message: '业务流优先级必须在 0…7 内。' });
    }
    if (flow.enabled && source && target && !topology.route(source.id, target.id, flow.id)) {
      issues.push({ severity: 'error', flowId: flow.id, message: '启用的业务流在两个端点之间没有可用路径。' });
    }
    if (flow.enabled && flow.fileSizeMb === 0 && flow.backgroundRateGbps === 0) {
      issues.push({ severity: 'warning', flowId: flow.id, message: '业务流文件大小和背景速率均为 0，不会发送数据。' });
    }
    if (flow.enabled && flow.startTimeUs >= config.settings.durationUs) {
      issues.push({ severity: 'warning', flowId: flow.id, message: '业务开始时间不早于仿真结束时间。' });
    }
  }

  if (!positive(config.settings.durationUs)) {
    issues.push({ severity: 'error', message: '仿真时长必须是正有限数。' });
  }
  if (!positive(config.settings.sampleIntervalUs)) {
    issues.push({ severity: 'error', message: '采样间隔必须是正有限数。' });
  }
  if (!positive(config.settings.maxFrameBytes)) {
    issues.push({ severity: 'error', message: '最大聚合帧字节数必须是正有限数。' });
  } else if (config.settings.maxFrameBytes > 1024 * KB) {
    issues.push({ severity: 'warning', message: '聚合帧超过 1 MiB，教学时延和排队粒度可能过粗。' });
  }
  if (!positive(config.settings.retransmissionTimeoutUs)) {
    issues.push({ severity: 'error', message: 'RTO 必须是正有限数。' });
  }
  if (!finite(config.settings.randomSeed)) {
    issues.push({ severity: 'error', message: '随机种子必须是有限数。' });
  }

  for (const convergence of calculateConvergence(config)) {
    if (convergence.accessGbps > 0 && convergence.uplinkGbps === 0) {
      issues.push({ severity: 'warning', nodeId: convergence.nodeId, message: 'Leaf 有接入带宽但没有启用的 Spine 上行。' });
    } else if (convergence.ratio > 1) {
      issues.push({
        severity: 'warning',
        nodeId: convergence.nodeId,
        message: `Leaf 接入/上行收敛比为 ${convergence.ratio.toFixed(2)}:1，存在上行超订。`,
      });
    }
  }
  return issues;
}

/** Leaf access bandwidth divided by enabled Leaf-Spine uplink bandwidth. */
export function calculateConvergence(config: NetworkConfig): ConvergenceInfo[] {
  const nodes = new Map(config.nodes.map((node) => [node.id, node]));
  return config.nodes
    .filter((node) => node.device === 'switch' && node.kind === 'leaf')
    .map((leaf) => {
      let accessGbps = 0;
      let uplinkGbps = 0;
      for (const link of config.links) {
        if (!link.enabled || !positive(link.rateGbps)) continue;
        const otherId = link.source === leaf.id ? link.target : link.target === leaf.id ? link.source : undefined;
        if (!otherId) continue;
        const other = nodes.get(otherId);
        if (other?.device === 'server') accessGbps += link.rateGbps;
        if (other?.kind === 'spine') uplinkGbps += link.rateGbps;
      }
      const ratio = uplinkGbps > 0 ? accessGbps / uplinkGbps : 0;
      const label = uplinkGbps > 0
        ? `${ratio.toFixed(2)}:1`
        : accessGbps > 0
          ? '无上行链路'
          : '无接入链路';
      return { nodeId: leaf.id, accessGbps, uplinkGbps, ratio, label };
    });
}

function stableHash(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Immutable enabled-link graph with deterministic, hop-count ECMP selection. */
export class NetworkTopology {
  readonly nodes: ReadonlyMap<string, NetworkNode>;
  readonly links: ReadonlyMap<string, NetworkLink>;
  private readonly adjacency = new Map<string, TopologyEdge[]>();

  constructor(config: NetworkConfig) {
    this.nodes = new Map(config.nodes.map((node) => [node.id, node]));
    this.links = new Map(config.links.map((link) => [link.id, link]));
    for (const node of config.nodes) this.adjacency.set(node.id, []);
    for (const link of config.links) {
      if (!link.enabled || !this.nodes.has(link.source) || !this.nodes.has(link.target) || link.source === link.target) continue;
      this.adjacency.get(link.source)?.push({ link, from: link.source, to: link.target });
      this.adjacency.get(link.target)?.push({ link, from: link.target, to: link.source });
    }
    for (const edges of this.adjacency.values()) {
      edges.sort((a, b) => a.link.id.localeCompare(b.link.id) || a.to.localeCompare(b.to));
    }
  }

  route(source: string, target: string, flowKey = ''): NetworkRoute | null {
    if (!this.nodes.has(source) || !this.nodes.has(target)) return null;
    if (source === target) return { nodeIds: [source], linkIds: [] };

    const distance = new Map<string, number>([[source, 0]]);
    const queue = [source];
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const nodeId = queue[cursor];
      const depth = distance.get(nodeId) ?? 0;
      for (const edge of this.adjacency.get(nodeId) ?? []) {
        if (!distance.has(edge.to)) {
          distance.set(edge.to, depth + 1);
          queue.push(edge.to);
        }
      }
    }
    const targetDistance = distance.get(target);
    if (targetDistance === undefined) return null;

    const paths: NetworkRoute[] = [];
    const visit = (nodeId: string, nodeIds: string[], linkIds: string[]): void => {
      if (paths.length >= MAX_ECMP_PATHS) return;
      if (nodeId === target) {
        paths.push({ nodeIds: [...nodeIds], linkIds: [...linkIds] });
        return;
      }
      const depth = distance.get(nodeId) ?? 0;
      for (const edge of this.adjacency.get(nodeId) ?? []) {
        if (distance.get(edge.to) !== depth + 1) continue;
        nodeIds.push(edge.to);
        linkIds.push(edge.link.id);
        visit(edge.to, nodeIds, linkIds);
        linkIds.pop();
        nodeIds.pop();
      }
    };
    visit(source, [source], []);
    if (!paths.length) return null;
    return paths[stableHash(flowKey) % paths.length];
  }

  reverse(route: NetworkRoute): NetworkRoute {
    return { nodeIds: [...route.nodeIds].reverse(), linkIds: [...route.linkIds].reverse() };
  }
}

export function directedLinkKey(linkId: string, from: string, to: string): string {
  return `${linkId}\u0000${from}\u0000${to}`;
}
