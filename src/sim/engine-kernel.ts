import { calculateConvergence, directedLinkKey, NetworkTopology, validateConfig, type NetworkRoute } from './topology';
import {
  PRIORITIES,
  type FlowMetric,
  type LinkMetric,
  type MetricFrame,
  type NetworkConfig,
  type NetworkLink,
  type NetworkNode,
  type PacketTrace,
  type Priority,
  type ServerNode,
  type SimulationEvent,
  type SimulationEventType,
  type SimulationResult,
  type SimulationSummary,
  type SwitchNode,
  type TrafficFlow,
} from './types';

const KB = 1024;
const MB = 1024 * 1024;
const RPC_BYTES = 256;
const ACK_BYTES = 64;
const SERVER_BUFFER_KB = 512;
const EVENT_CHUNK = 500;
const MAX_RETRANSMISSIONS = 12;

export const SIMULATION_LIMITS = Object.freeze({
  maxFrames: 80_000,
  maxEvents: 300_000,
  maxMetricFrames: 600,
  maxTraces: 4_000,
  maxKeyEvents: 8_000,
  maxOperationsPerFlow: 100_000,
});

/** Mulberry32: small, deterministic and independent of platform crypto/DOM APIs. */
export class SeededRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let value = this.state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  }
}

type PacketKind = PacketTrace['kind'];
type ControlKind = 'request' | 'ready' | 'ack';
type OperationPhase = 'request' | 'ready' | 'data' | 'ack' | 'done';

interface Packet {
  id: number;
  flowId?: string;
  operationId?: number;
  frameIndex?: number;
  kind: PacketKind;
  controlKind?: ControlKind;
  priority: Priority;
  bytes: number;
  route: NetworkRoute;
  hop: number;
  marked: boolean;
  attempt: number;
  createdUs: number;
  pfcOn?: boolean;
  pauseSourceKey?: string;
  pauseTargetKey?: string;
  pausedPriority?: Priority;
}

interface QueuedPacket {
  packet: Packet;
  incomingKey?: string;
}

interface PortRuntime {
  key: string;
  link: NetworkLink;
  from: string;
  to: string;
  queues: QueuedPacket[][];
  control: QueuedPacket[];
  bytes: number;
  priorityBytes: number[];
  ingressBytes: number;
  deficits: number[];
  cursor: number;
  transmitting: boolean;
  pauseSources: Array<Set<string>>;
  pauseSince: number[];
  pfcBusyUs: number[];
  xoffActive: boolean[];
  xoffTargets: Array<Set<string>>;
}

interface NodeRuntime {
  node: NetworkNode;
  sharedUsedBytes: number;
}

interface LinkRuntime {
  intervalBytes: number;
  intervalGoodputBytes: number;
  ecnMarks: number;
  drops: number;
  pfcPauses: number;
}

interface Operation {
  id: number;
  offset: number;
  bytes: number;
  phase: OperationPhase;
  createdUs: number;
  lastActivityUs: number;
  receivedFrames: Set<number>;
  receivedBytes: number;
  ackSent: boolean;
  retries: number;
  dataGeneration: number;
}

interface PendingData {
  operation: Operation;
  generation: number;
  cursor: number;
}

interface FlowRuntime {
  config: TrafficFlow;
  compute: ServerNode;
  storage: ServerNode;
  dataSource: ServerNode;
  dataReceiver: ServerNode;
  read: boolean;
  frameBytes: number;
  requestBytes: number;
  totalBytes: number;
  generatedBytes: number;
  deliveredBytes: number;
  intervalDeliveredBytes: number;
  operations: Map<number, Operation>;
  pendingData: PendingData[];
  nextOperationId: number;
  createdOperations: number;
  issueScheduled: boolean;
  pumpScheduled: boolean;
  backgroundScheduled: boolean;
  nextDataSendUs: number;
  nextBackgroundUs: number;
  routes: { request: NetworkRoute; ready: NetworkRoute; data: NetworkRoute; ack: NetworkRoute };
  rate: number;
  targetRate: number;
  minRate: number;
  maxRate: number;
  alpha: number;
  lastCnpUs: number;
  retransmissions: number;
  rttUs: number;
  started: boolean;
  completed: boolean;
  warnedRetryLimit: boolean;
}

type KernelEvent =
  | { timeUs: number; sequence: number; type: 'arrival'; packet: Packet; portKey: string }
  | { timeUs: number; sequence: number; type: 'forward'; packet: Packet; incomingKey: string }
  | { timeUs: number; sequence: number; type: 'tx-done'; portKey: string; packet: Packet }
  | { timeUs: number; sequence: number; type: 'issue' | 'pump' | 'background' | 'recovery'; flowId: string }
  | { timeUs: number; sequence: number; type: 'rto'; flowId: string; operationId: number }
  | { timeUs: number; sequence: number; type: 'sample' };

type KernelEventInput = KernelEvent extends infer T
  ? T extends KernelEvent
    ? Omit<T, 'timeUs' | 'sequence'>
    : never
  : never;

class EventHeap {
  private readonly values: KernelEvent[] = [];

  get length(): number {
    return this.values.length;
  }

  push(event: KernelEvent): void {
    this.values.push(event);
    let index = this.values.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.compare(this.values[parent], event) <= 0) break;
      this.values[index] = this.values[parent];
      index = parent;
    }
    this.values[index] = event;
  }

  pop(): KernelEvent | undefined {
    if (!this.values.length) return undefined;
    const first = this.values[0];
    const last = this.values.pop() as KernelEvent;
    if (this.values.length) {
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        if (left >= this.values.length) break;
        const right = left + 1;
        const child = right < this.values.length && this.compare(this.values[right], this.values[left]) < 0 ? right : left;
        if (this.compare(this.values[child], last) >= 0) break;
        this.values[index] = this.values[child];
        index = child;
      }
      this.values[index] = last;
    }
    return first;
  }

  private compare(a: KernelEvent, b: KernelEvent): number {
    return a.timeUs - b.timeUs || a.sequence - b.sequence;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function gbps(bytes: number, durationUs: number): number {
  return durationUs > 0 ? (bytes * 8) / (durationUs * 1_000) : 0;
}

function serializationUs(bytes: number, rateGbps: number): number {
  return (bytes * 8) / Math.max(rateGbps * 1_000, 1e-9);
}

function reverseKey(key: string, ports: ReadonlyMap<string, PortRuntime>): string | undefined {
  const port = ports.get(key);
  return port ? directedLinkKey(port.link.id, port.to, port.from) : undefined;
}

function emptySummary(config: NetworkConfig): SimulationSummary {
  return {
    durationUs: 0,
    offeredGbps: 0,
    goodputGbps: 0,
    peakQueueKb: 0,
    ecnMarks: 0,
    cnpCount: 0,
    drops: 0,
    retransmissions: 0,
    pfcPauses: 0,
    pfcBusyUs: 0,
    averageRttUs: 0,
    p95RttUs: 0,
    maxRttUs: 0,
    completedFlows: 0,
    totalFlows: config.flows.filter((flow) => flow.enabled).length,
    convergence: calculateConvergence(config),
    insights: [],
  };
}

export class SimulationKernel {
  private readonly topology: NetworkTopology;
  private readonly heap = new EventHeap();
  private readonly ports = new Map<string, PortRuntime>();
  private readonly nodes = new Map<string, NodeRuntime>();
  private readonly links = new Map<string, LinkRuntime>();
  private readonly flows = new Map<string, FlowRuntime>();
  private readonly ecnRandom: SeededRandom;
  private readonly traceRandom: SeededRandom;
  private readonly frames: MetricFrame[] = [];
  private readonly events: SimulationEvent[] = [];
  private readonly traces: PacketTrace[] = [];
  private readonly operationRttsUs: number[] = [];
  private sequence = 0;
  private packetId = 0;
  private eventId = 0;
  private traceId = 0;
  private seenTraces = 0;
  private createdFrames = 0;
  private processedEvents = 0;
  private now = 0;
  private lastSampleUs = 0;
  private intervalOfferedBytes = 0;
  private offeredBytes = 0;
  private goodputBytes = 0;
  private cnpCount = 0;
  private peakQueueKb = 0;
  private frameLimited = false;
  private eventLimited = false;
  private keyEventLimited = false;
  private cancelled = false;

  constructor(private readonly config: NetworkConfig) {
    this.topology = new NetworkTopology(config);
    const seed = config.settings.randomSeed >>> 0;
    this.ecnRandom = new SeededRandom(seed ^ 0x9e3779b9);
    this.traceRandom = new SeededRandom(seed ^ 0x85ebca6b);
  }

  async run(onProgress?: (progress: number) => void, shouldCancel?: () => boolean): Promise<SimulationResult> {
    const issues = validateConfig(this.config);
    if (issues.some((issue) => issue.severity === 'error')) {
      for (const issue of issues) {
        this.emit(issue.severity === 'error' ? 'warning' : 'warning', issue.message, issue);
      }
      const summary = emptySummary(this.config);
      summary.insights = ['配置存在错误，未运行仿真；请先修复校验错误。'];
      onProgress?.(1);
      return { frames: [], events: this.events, traces: [], summary };
    }

    this.setup();
    this.captureMetrics(0);
    onProgress?.(0);
    while (this.heap.length && this.processedEvents < SIMULATION_LIMITS.maxEvents) {
      if (this.processedEvents % EVENT_CHUNK === 0) {
        if (shouldCancel?.()) {
          this.cancelled = true;
          break;
        }
        if (this.processedEvents > 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          onProgress?.(clamp(this.now / this.config.settings.durationUs, 0, 1));
        }
      }
      const event = this.heap.pop();
      if (!event || event.timeUs > this.config.settings.durationUs) break;
      this.now = Math.max(this.now, event.timeUs);
      this.process(event);
      this.processedEvents += 1;
    }
    if (this.heap.length && this.processedEvents >= SIMULATION_LIMITS.maxEvents) this.eventLimited = true;
    if (shouldCancel?.()) this.cancelled = true;
    if (!this.cancelled && !this.eventLimited) this.now = this.config.settings.durationUs;

    if (this.cancelled) this.emit('warning', `模拟在 ${this.now.toFixed(1)} µs 被取消，返回部分结果。`);
    if (this.eventLimited) this.emit('warning', '事件数达到安全上限，结果在截断点前有效。');
    if (this.frameLimited) this.emit('warning', '帧数达到安全上限，后续新帧未生成。');
    if (this.keyEventLimited) this.emit('warning', '关键事件记录达到上限，计数器仍保留累计值。');
    if (this.now > this.lastSampleUs || !this.frames.length) this.captureMetrics(this.now);
    onProgress?.(this.cancelled || this.eventLimited ? clamp(this.now / this.config.settings.durationUs, 0, 1) : 1);
    this.traces.sort((a, b) => a.timeUs - b.timeUs || a.id - b.id);
    return { frames: this.frames, events: this.events, traces: this.traces, summary: this.makeSummary() };
  }

  private setup(): void {
    for (const node of this.config.nodes) {
      this.nodes.set(node.id, { node, sharedUsedBytes: 0 });
    }
    for (const link of this.config.links) {
      this.links.set(link.id, { intervalBytes: 0, intervalGoodputBytes: 0, ecnMarks: 0, drops: 0, pfcPauses: 0 });
      if (!link.enabled) continue;
      this.addPort(link, link.source, link.target);
      this.addPort(link, link.target, link.source);
    }
    for (const flow of this.config.flows) {
      if (flow.enabled) this.setupFlow(flow);
    }
    const requestedSamples = this.config.settings.durationUs / this.config.settings.sampleIntervalUs;
    const stride = Math.max(1, Math.ceil(requestedSamples / (SIMULATION_LIMITS.maxMetricFrames - 2)));
    const step = this.config.settings.sampleIntervalUs * stride;
    for (let timeUs = step; timeUs < this.config.settings.durationUs; timeUs += step) {
      this.schedule(timeUs, { type: 'sample' });
    }
  }

  private addPort(link: NetworkLink, from: string, to: string): void {
    const key = directedLinkKey(link.id, from, to);
    this.ports.set(key, {
      key,
      link,
      from,
      to,
      queues: PRIORITIES.map(() => []),
      control: [],
      bytes: 0,
      priorityBytes: Array(8).fill(0),
      ingressBytes: 0,
      deficits: Array(8).fill(0),
      cursor: 0,
      transmitting: false,
      pauseSources: PRIORITIES.map(() => new Set<string>()),
      pauseSince: Array(8).fill(Number.NaN),
      pfcBusyUs: Array(8).fill(0),
      xoffActive: Array(8).fill(false),
      xoffTargets: PRIORITIES.map(() => new Set<string>()),
    });
  }

  private setupFlow(config: TrafficFlow): void {
    const first = this.topology.nodes.get(config.source);
    const second = this.topology.nodes.get(config.target);
    if (!first || !second || first.device !== 'server' || second.device !== 'server') return;
    const compute = first.kind === 'compute' ? first : second.kind === 'compute' ? second : null;
    const storage = first.kind === 'storage' ? first : second.kind === 'storage' ? second : null;
    if (!compute || !storage) return;
    const request = this.topology.route(compute.id, storage.id, `${this.config.settings.randomSeed}:${config.id}`);
    if (!request || !request.linkIds.length) {
      this.emit('warning', '业务流没有可用路径，已跳过。', { flowId: config.id });
      return;
    }
    const backgroundOnly = config.template === 'mixed-background';
    const read = config.template.startsWith('read');
    const dataSource = read ? storage : compute;
    const dataReceiver = read ? compute : storage;
    const dcqcn = dataSource.nic.dcqcn;
    const maxRate = backgroundOnly
      ? Math.max(0, Math.min(config.backgroundRateGbps, compute.nic.rateGbps))
      : Math.max(0.001, Math.min(dataSource.nic.rateGbps, storage.serviceLimitGbps, dcqcn.maxRateGbps));
    const minRate = backgroundOnly ? maxRate : Math.min(maxRate, dcqcn.minRateGbps);
    const initialRate = backgroundOnly ? maxRate : dcqcn.enabled ? clamp(dcqcn.initialRateGbps, minRate, maxRate) : maxRate;
    const ready = this.topology.reverse(request);
    const data = read ? ready : request;
    const state: FlowRuntime = {
      config,
      compute,
      storage,
      dataSource,
      dataReceiver,
      read,
      frameBytes: clamp(Math.floor(this.config.settings.maxFrameBytes), 1, Number.MAX_SAFE_INTEGER),
      requestBytes: clamp(Math.round(config.requestSizeKb * KB), 1, Number.MAX_SAFE_INTEGER),
      totalBytes: backgroundOnly ? 0 : clamp(Math.round(config.fileSizeMb * MB), 0, Number.MAX_SAFE_INTEGER),
      generatedBytes: 0,
      deliveredBytes: 0,
      intervalDeliveredBytes: 0,
      operations: new Map(),
      pendingData: [],
      nextOperationId: 0,
      createdOperations: 0,
      issueScheduled: false,
      pumpScheduled: false,
      backgroundScheduled: false,
      nextDataSendUs: config.startTimeUs,
      nextBackgroundUs: config.startTimeUs,
      routes: { request, ready, data, ack: this.topology.reverse(data) },
      rate: initialRate,
      targetRate: initialRate,
      minRate,
      maxRate,
      alpha: clamp(dcqcn.alpha, 0, 1),
      lastCnpUs: Number.NEGATIVE_INFINITY,
      retransmissions: 0,
      rttUs: 0,
      started: false,
      completed: false,
      warnedRetryLimit: false,
    };
    this.flows.set(config.id, state);
    if (!backgroundOnly) this.scheduleIssue(state, config.startTimeUs);
    if (!backgroundOnly && dcqcn.enabled) {
      this.schedule(config.startTimeUs + dcqcn.recoveryIntervalUs, { type: 'recovery', flowId: config.id });
    }
    if (backgroundOnly && config.backgroundRateGbps > 0) {
      state.backgroundScheduled = true;
      this.schedule(config.startTimeUs, { type: 'background', flowId: config.id });
    }
  }

  private schedule(timeUs: number, event: KernelEventInput): void {
    if (!Number.isFinite(timeUs) || timeUs > this.config.settings.durationUs) return;
    this.heap.push({ ...event, timeUs: Math.max(this.now, timeUs), sequence: this.sequence++ } as KernelEvent);
  }

  private process(event: KernelEvent): void {
    switch (event.type) {
      case 'arrival': this.arrive(event.packet, event.portKey); break;
      case 'forward': this.forward(event.packet, event.incomingKey); break;
      case 'tx-done': this.finishTransmission(event.portKey, event.packet); break;
      case 'issue': this.issue(event.flowId); break;
      case 'pump': this.pump(event.flowId); break;
      case 'background': this.background(event.flowId); break;
      case 'recovery': this.recover(event.flowId); break;
      case 'rto': this.retransmit(event.flowId, event.operationId); break;
      case 'sample': this.captureMetrics(event.timeUs); break;
    }
  }

  private createPacket(input: Omit<Packet, 'id' | 'hop' | 'marked' | 'attempt' | 'createdUs'> & { attempt?: number }): Packet | null {
    if (this.createdFrames >= SIMULATION_LIMITS.maxFrames) {
      this.frameLimited = true;
      return null;
    }
    this.createdFrames += 1;
    this.offeredBytes += input.bytes;
    this.intervalOfferedBytes += input.bytes;
    return { ...input, id: this.packetId++, hop: 0, marked: false, attempt: input.attempt ?? 0, createdUs: this.now };
  }

  private sendRoute(packet: Packet | null): void {
    if (!packet || !packet.route.linkIds.length) return;
    const from = packet.route.nodeIds[0];
    const to = packet.route.nodeIds[1];
    const key = directedLinkKey(packet.route.linkIds[0], from, to);
    this.enqueue(packet, key);
  }

  private enqueue(packet: Packet, portKey: string, incomingKey?: string): void {
    const port = this.ports.get(portKey);
    if (!port) return;
    const queued = { packet, incomingKey };
    const control = packet.kind === 'control' || packet.kind === 'cnp' || packet.kind === 'pfc';
    const dropReason = control ? null : this.reserve(port, packet.bytes, packet.priority);
    if (dropReason) {
      this.drop(packet, port, dropReason);
      return;
    }
    if (control) port.control.push(queued);
    else {
      port.queues[packet.priority].push(queued);
      port.bytes += packet.bytes;
      port.priorityBytes[packet.priority] += packet.bytes;
      this.applyEcn(packet, port);
      this.peakQueueKb = Math.max(this.peakQueueKb, port.bytes / KB);
    }
    this.servicePort(port);
    if (!control) this.updatePfcAfterEnqueue(port, packet.priority, incomingKey);
  }

  private reserve(port: PortRuntime, bytes: number, priority: Priority): string | null {
    const node = this.nodes.get(port.from);
    if (!node) return '端口缓冲不可用';
    // A lossless-priority NIC applies host-side backpressure. Data may wait in
    // the much larger host transmit queue after a pause; it must not be dropped
    // in the small NIC hardware queue when XON arrives and draining resumes.
    if (node.node.device === 'server') {
      const pfc = node.node.nic.pfc;
      if (pfc.enabled && pfc.priorities.includes(priority)) return null;
    }
    const reservedBytes = (node.node.device === 'switch' ? node.node.switch.bufferPerPortKb : SERVER_BUFFER_KB) * KB;
    const sharedCapacity = node.node.device === 'switch' && node.node.switch.sharedBufferEnabled ? node.node.switch.sharedBufferKb * KB : 0;
    if (node.node.device === 'switch' && port.bytes + bytes > reservedBytes) {
      const config = node.node.switch;
      const freeShared = Math.max(0, sharedCapacity - node.sharedUsedBytes);
      const watermarkBytes = config.tailDropMode === 'static'
        ? Math.max(reservedBytes, config.staticWatermarkKb * KB)
        : reservedBytes + freeShared * Math.max(0, config.dynamicAlpha);
      if (port.bytes + bytes > watermarkBytes) {
        const mode = config.tailDropMode === 'static' ? 'static' : 'shared dynamic';
        return `${mode} 尾丢水线 ${(watermarkBytes / KB).toFixed(1)} KiB 已超出`;
      }
    }
    const sharedBefore = Math.max(0, port.bytes - reservedBytes);
    const sharedAfter = Math.max(0, port.bytes + bytes - reservedBytes);
    const needed = Math.max(0, sharedAfter - sharedBefore);
    if (port.bytes + bytes <= reservedBytes) return null;
    if (needed <= 0 || node.sharedUsedBytes + needed > sharedCapacity) {
      return node.node.device === 'server' ? '主机 NIC 缓冲已耗尽' : '交换机共享内存已耗尽';
    }
    node.sharedUsedBytes += needed;
    return null;
  }

  private release(port: PortRuntime, bytes: number): void {
    const node = this.nodes.get(port.from);
    if (!node) return;
    const reservedBytes = (node.node.device === 'switch' ? node.node.switch.bufferPerPortKb : SERVER_BUFFER_KB) * KB;
    const sharedBefore = Math.max(0, port.bytes - reservedBytes);
    const sharedAfter = Math.max(0, port.bytes - bytes - reservedBytes);
    node.sharedUsedBytes = Math.max(0, node.sharedUsedBytes - Math.max(0, sharedBefore - sharedAfter));
    port.bytes = Math.max(0, port.bytes - bytes);
  }

  private applyEcn(packet: Packet, port: PortRuntime): void {
    const node = this.nodes.get(port.from)?.node;
    if (!node) return;
    // NicConfig deliberately has no ECN knobs. For a server-to-leaf bottleneck,
    // use the receiving leaf's policy on the NIC egress queue; otherwise an
    // Incast could tail-drop at the storage NIC without any congestion feedback.
    const ecn = node.device === 'switch'
      ? node.switch.ecn
      : this.nodes.get(port.to)?.node.device === 'switch'
        ? (this.nodes.get(port.to)?.node as SwitchNode).switch.ecn
        : undefined;
    if (!ecn?.enabled || packet.marked || (packet.kind !== 'data' && packet.kind !== 'background') || !ecn.priorities.includes(packet.priority)) return;
    const queueKb = port.priorityBytes[packet.priority] / KB;
    let probability = 0;
    if (queueKb >= ecn.maxKb) probability = ecn.maxProbability;
    else if (queueKb > ecn.minKb) probability = ecn.maxProbability * ((queueKb - ecn.minKb) / (ecn.maxKb - ecn.minKb));
    if (this.ecnRandom.next() >= probability) return;
    packet.marked = true;
    const link = this.links.get(port.link.id);
    if (link) link.ecnMarks += 1;
    this.emit('ecn', `队列 ${queueKb.toFixed(1)} KiB，按 ${(probability * 100).toFixed(1)}% 概率标记 ECN。`, {
      nodeId: port.from,
      linkId: port.link.id,
      flowId: packet.flowId,
      priority: packet.priority,
      value: queueKb,
    });
  }

  private servicePort(port: PortRuntime): void {
    if (port.transmitting) return;
    const selected = this.selectPacket(port);
    if (!selected) return;
    const { packet } = selected;
    if (packet.kind === 'data' || packet.kind === 'background') {
      port.priorityBytes[packet.priority] = Math.max(0, port.priorityBytes[packet.priority] - packet.bytes);
      this.release(port, packet.bytes);
      this.updatePfcAfterDequeue(port, packet.priority);
    }
    port.transmitting = true;
    const txUs = serializationUs(packet.bytes, port.link.rateGbps);
    const link = this.links.get(port.link.id);
    if (link) {
      link.intervalBytes += packet.bytes;
      if ((packet.kind === 'data' || packet.kind === 'background') && packet.attempt === 0) link.intervalGoodputBytes += packet.bytes;
    }
    this.recordTrace(packet, port, txUs + port.link.propagationUs);
    this.schedule(this.now + txUs, { type: 'tx-done', portKey: port.key, packet });
  }

  private selectPacket(port: PortRuntime): QueuedPacket | null {
    const node = this.nodes.get(port.from)?.node;
    if (!node) return null;
    const dwrr = node.device === 'switch' ? node.switch.dwrr : node.nic.dwrr;
    if (port.control.length && dwrr.controlStrictPriority) return port.control.shift() ?? null;
    const available = (priority: Priority): boolean => port.queues[priority].length > 0 && port.pauseSources[priority].size === 0;
    let selected: Priority | null = null;
    if (!dwrr.enabled) {
      for (let priority = 7; priority >= 0; priority -= 1) {
        if (available(priority as Priority)) { selected = priority as Priority; break; }
      }
    } else {
      let positiveWeight = false;
      for (const priority of PRIORITIES) if (available(priority) && dwrr.weights[priority] > 0) positiveWeight = true;
      if (positiveWeight) {
        for (let offset = 0; offset < 8; offset += 1) {
          const priority = ((port.cursor + offset) % 8) as Priority;
          const queue = port.queues[priority];
          if (!queue.length) { port.deficits[priority] = 0; continue; }
          if (!available(priority) || dwrr.weights[priority] <= 0) continue;
          const headBytes = queue[0].packet.bytes;
          if (port.deficits[priority] < headBytes) {
            const quantum = Math.max(1, dwrr.weights[priority]) * Math.max(1, this.config.settings.maxFrameBytes);
            port.deficits[priority] += quantum;
          }
          if (port.deficits[priority] >= headBytes) {
            selected = priority;
            port.deficits[priority] -= headBytes;
            port.cursor = priority;
            break;
          }
        }
      } else {
        for (let priority = 7; priority >= 0; priority -= 1) {
          if (available(priority as Priority)) { selected = priority as Priority; break; }
        }
      }
    }
    if (selected !== null) return port.queues[selected].shift() ?? null;
    return port.control.shift() ?? null;
  }

  private finishTransmission(portKey: string, packet: Packet): void {
    const port = this.ports.get(portKey);
    if (!port) return;
    port.transmitting = false;
    this.schedule(this.now + port.link.propagationUs, { type: 'arrival', packet, portKey });
    this.servicePort(port);
  }

  private arrive(packet: Packet, portKey: string): void {
    const incoming = this.ports.get(portKey);
    if (!incoming) return;
    if (packet.kind === 'pfc') {
      this.applyPfc(packet);
      return;
    }
    if (packet.hop >= packet.route.linkIds.length - 1) {
      if (packet.kind === 'cnp') this.applyCnp(packet);
      else this.deliver(packet);
      return;
    }
    const node = this.nodes.get(incoming.to)?.node;
    if (!node || node.device !== 'switch') return;
    incoming.ingressBytes += packet.bytes;
    this.peakQueueKb = Math.max(this.peakQueueKb, incoming.ingressBytes / KB);
    this.schedule(this.now + node.switch.switchingDelayUs, { type: 'forward', packet, incomingKey: portKey });
  }

  private forward(packet: Packet, incomingKey: string): void {
    const incoming = this.ports.get(incomingKey);
    if (incoming) incoming.ingressBytes = Math.max(0, incoming.ingressBytes - packet.bytes);
    packet.hop += 1;
    if (packet.hop >= packet.route.linkIds.length) return;
    const from = packet.route.nodeIds[packet.hop];
    const to = packet.route.nodeIds[packet.hop + 1];
    const key = directedLinkKey(packet.route.linkIds[packet.hop], from, to);
    this.enqueue(packet, key, incomingKey);
  }

  private drop(packet: Packet, port: PortRuntime, reason: string): void {
    const link = this.links.get(port.link.id);
    if (link) link.drops += 1;
    this.emit('drop', `${reason}，${packet.kind} 帧被丢弃；可靠 NFS 操作将等待 RTO。`, {
      nodeId: port.from,
      linkId: port.link.id,
      flowId: packet.flowId,
      priority: packet.priority,
      value: packet.bytes,
    });
  }

  private updatePfcAfterEnqueue(port: PortRuntime, priority: Priority, incomingKey?: string): void {
    const node = this.nodes.get(port.from)?.node;
    if (!node || node.device !== 'switch' || !incomingKey) return;
    const pfc = node.switch.pfc;
    if (!pfc.enabled || !pfc.priorities.includes(priority)) return;
    if (!port.xoffActive[priority] && port.priorityBytes[priority] >= pfc.xoffKb * KB) {
      port.xoffActive[priority] = true;
    }
    if (port.xoffActive[priority] && !port.xoffTargets[priority].has(incomingKey)) {
      port.xoffTargets[priority].add(incomingKey);
      this.sendPfc(port, incomingKey, priority, true);
    }
  }

  private updatePfcAfterDequeue(port: PortRuntime, priority: Priority): void {
    const node = this.nodes.get(port.from)?.node;
    if (!node || node.device !== 'switch' || !port.xoffActive[priority]) return;
    if (port.priorityBytes[priority] > node.switch.pfc.xonKb * KB) return;
    port.xoffActive[priority] = false;
    const targets = [...port.xoffTargets[priority]];
    port.xoffTargets[priority].clear();
    for (const target of targets) this.sendPfc(port, target, priority, false);
  }

  private sendPfc(source: PortRuntime, targetKey: string, priority: Priority, on: boolean): void {
    const signalKey = reverseKey(targetKey, this.ports);
    const signal = signalKey ? this.ports.get(signalKey) : undefined;
    if (!signal || !signalKey) return;
    const route: NetworkRoute = { nodeIds: [signal.from, signal.to], linkIds: [signal.link.id] };
    const packet = this.createPacket({
      kind: 'pfc', priority: 7, bytes: 64, route,
      pfcOn: on, pauseSourceKey: source.key, pauseTargetKey: targetKey, pausedPriority: priority,
    });
    if (packet) this.enqueue(packet, signalKey);
    this.emit(on ? 'pfc-on' : 'pfc-off', `拥塞端口向上游发送 PFC ${on ? 'XOFF' : 'XON'}（P${priority}）。`, {
      nodeId: source.from, linkId: source.link.id, priority,
    });
  }

  private applyPfc(packet: Packet): void {
    const target = packet.pauseTargetKey ? this.ports.get(packet.pauseTargetKey) : undefined;
    if (!target || !packet.pauseSourceKey) return;
    const priority = packet.pausedPriority ?? 3;
    const owner = this.nodes.get(target.from)?.node;
    const pfc = owner?.device === 'switch' ? owner.switch.pfc : owner?.device === 'server' ? owner.nic.pfc : undefined;
    if (!pfc?.enabled || !pfc.priorities.includes(priority)) return;
    const sources = target.pauseSources[priority];
    const wasPaused = sources.size > 0;
    if (packet.pfcOn) sources.add(packet.pauseSourceKey);
    else sources.delete(packet.pauseSourceKey);
    const paused = sources.size > 0;
    const link = this.links.get(target.link.id);
    if (!wasPaused && paused) {
      target.pauseSince[priority] = this.now;
      if (link) link.pfcPauses += 1;
    } else if (wasPaused && !paused) {
      target.pfcBusyUs[priority] += Math.max(0, this.now - target.pauseSince[priority]);
      target.pauseSince[priority] = Number.NaN;
      this.servicePort(target);
    }
  }

  private applyCnp(packet: Packet): void {
    const flow = packet.flowId ? this.flows.get(packet.flowId) : undefined;
    if (!flow || !flow.dataSource.nic.dcqcn.enabled) return;
    const dcqcn = flow.dataSource.nic.dcqcn;
    const oldRate = flow.rate;
    flow.targetRate = Math.max(flow.minRate, Math.min(flow.targetRate, oldRate));
    flow.rate = Math.max(flow.minRate, oldRate * (1 - flow.alpha / 2));
    flow.alpha = clamp(flow.alpha * (1 - dcqcn.alphaGain) + dcqcn.alphaGain, 0, 1);
    if (flow.rate < oldRate - 1e-9) {
      this.emit('rate-down', `收到 CNP：alpha=${flow.alpha.toFixed(3)}，速率 ${oldRate.toFixed(2)} → ${flow.rate.toFixed(2)} Gbit/s。`, {
        nodeId: flow.dataSource.id, flowId: flow.config.id, value: flow.rate,
      });
    }
  }

  private recordTrace(packet: Packet, port: PortRuntime, durationUs: number): void {
    const trace: PacketTrace = {
      id: this.traceId++, timeUs: this.now, endUs: this.now + durationUs,
      linkId: port.link.id, fromNodeId: port.from, toNodeId: port.to,
      flowId: packet.flowId, kind: packet.kind,
      priority: packet.priority, marked: packet.marked,
    };
    this.seenTraces += 1;
    if (this.traces.length < SIMULATION_LIMITS.maxTraces) this.traces.push(trace);
    else {
      const index = Math.floor(this.traceRandom.next() * this.seenTraces);
      if (index < SIMULATION_LIMITS.maxTraces) this.traces[index] = trace;
    }
  }

  private emit(type: SimulationEventType, message: string, fields: Partial<SimulationEvent> = {}): void {
    if (this.events.length >= SIMULATION_LIMITS.maxKeyEvents) {
      this.keyEventLimited = true;
      return;
    }
    this.events.push({ id: this.eventId++, timeUs: this.now, type, message, ...fields });
  }

  private scheduleIssue(flow: FlowRuntime, timeUs: number): void {
    if (flow.issueScheduled || flow.completed || timeUs > this.config.settings.durationUs) return;
    flow.issueScheduled = true;
    this.schedule(Math.max(this.now, timeUs), { type: 'issue', flowId: flow.config.id });
  }

  private nextBurstStart(flow: FlowRuntime, timeUs: number): number {
    const { startTimeUs, burstIntervalUs, burstDurationUs } = flow.config;
    if (burstIntervalUs <= 0) return timeUs;
    const activeDuration = burstDurationUs > 0 ? Math.min(burstDurationUs, burstIntervalUs) : burstIntervalUs;
    const elapsed = Math.max(0, timeUs - startTimeUs);
    const position = elapsed % burstIntervalUs;
    if (position < activeDuration) return timeUs;
    return startTimeUs + (Math.floor(elapsed / burstIntervalUs) + 1) * burstIntervalUs;
  }

  private issue(flowId: string): void {
    const flow = this.flows.get(flowId);
    if (!flow) return;
    flow.issueScheduled = false;
    if (flow.completed || flow.generatedBytes >= flow.totalBytes) return;
    if (!flow.started) {
      flow.started = true;
      this.emit('flow-start', `${flow.read ? 'NFS READ' : 'NFS WRITE'} 业务开始。`, { flowId, nodeId: flow.compute.id });
    }
    const microburst = flow.config.template.includes('microburst');
    const activeTime = microburst ? this.nextBurstStart(flow, this.now) : this.now;
    if (activeTime > this.now) {
      this.scheduleIssue(flow, activeTime);
      return;
    }
    while (
      flow.operations.size < flow.config.queueDepth
      && flow.generatedBytes < flow.totalBytes
      && flow.createdOperations < SIMULATION_LIMITS.maxOperationsPerFlow
    ) {
      const bytes = Math.min(flow.requestBytes, flow.totalBytes - flow.generatedBytes);
      const operation: Operation = {
        id: flow.nextOperationId++,
        offset: flow.generatedBytes,
        bytes,
        phase: 'request',
        createdUs: this.now,
        lastActivityUs: this.now,
        receivedFrames: new Set(),
        receivedBytes: 0,
        ackSent: false,
        retries: 0,
        dataGeneration: 0,
      };
      flow.generatedBytes += bytes;
      flow.createdOperations += 1;
      flow.operations.set(operation.id, operation);
      this.sendControl(flow, operation, 'request');
      this.schedule(this.now + this.config.settings.retransmissionTimeoutUs, {
        type: 'rto', flowId, operationId: operation.id,
      });
    }
    if (flow.generatedBytes < flow.totalBytes && flow.operations.size < flow.config.queueDepth) {
      this.scheduleIssue(flow, this.now);
    }
  }

  private sendControl(flow: FlowRuntime, operation: Operation, kind: ControlKind): void {
    const route = kind === 'request' ? flow.routes.request : kind === 'ready' ? flow.routes.ready : flow.routes.ack;
    const packet = this.createPacket({
      flowId: flow.config.id,
      operationId: operation.id,
      kind: 'control',
      controlKind: kind,
      priority: 6,
      bytes: kind === 'ack' ? ACK_BYTES : RPC_BYTES,
      route,
      attempt: operation.retries,
    });
    this.sendRoute(packet);
  }

  private queueData(flow: FlowRuntime, operation: Operation): void {
    operation.dataGeneration += 1;
    flow.pendingData = flow.pendingData.filter((pending) => pending.operation.id !== operation.id);
    flow.pendingData.push({ operation, generation: operation.dataGeneration, cursor: 0 });
    this.schedulePump(flow, this.now);
  }

  private schedulePump(flow: FlowRuntime, timeUs: number): void {
    if (flow.pumpScheduled || this.frameLimited) return;
    flow.pumpScheduled = true;
    this.schedule(Math.max(this.now, timeUs), { type: 'pump', flowId: flow.config.id });
  }

  private pump(flowId: string): void {
    const flow = this.flows.get(flowId);
    if (!flow) return;
    flow.pumpScheduled = false;
    while (flow.pendingData.length) {
      const pending = flow.pendingData[0];
      if (
        pending.generation !== pending.operation.dataGeneration
        || pending.operation.phase !== 'data'
      ) {
        flow.pendingData.shift();
        continue;
      }
      if (this.frameLimited) return;
      const operation = pending.operation;
      const bytes = Math.min(flow.frameBytes, operation.bytes - pending.cursor);
      const frameIndex = Math.floor(pending.cursor / flow.frameBytes);
      const packet = this.createPacket({
        flowId,
        operationId: operation.id,
        frameIndex,
        kind: 'data',
        priority: flow.config.priority,
        bytes,
        route: flow.routes.data,
        attempt: operation.retries,
      });
      if (!packet) return;
      this.sendRoute(packet);
      pending.cursor += bytes;
      if (pending.cursor >= operation.bytes) flow.pendingData.shift();
      flow.nextDataSendUs = Math.max(this.now, flow.nextDataSendUs) + serializationUs(bytes, flow.rate);
      if (flow.pendingData.length) this.schedulePump(flow, flow.nextDataSendUs);
      return;
    }
  }

  private background(flowId: string): void {
    const flow = this.flows.get(flowId);
    if (!flow) return;
    flow.backgroundScheduled = false;
    if (this.frameLimited || flow.config.backgroundRateGbps <= 0) return;
    if (!flow.started) {
      flow.started = true;
      this.emit('flow-start', '混合业务与背景流开始。', { flowId, nodeId: flow.compute.id });
    }
    const packet = this.createPacket({
      flowId,
      kind: 'background',
      priority: flow.config.priority,
      bytes: flow.frameBytes,
      route: flow.routes.request,
    });
    this.sendRoute(packet);
    flow.nextBackgroundUs = Math.max(this.now, flow.nextBackgroundUs)
      + serializationUs(flow.frameBytes, flow.config.backgroundRateGbps);
    if (flow.nextBackgroundUs <= this.config.settings.durationUs) {
      flow.backgroundScheduled = true;
      this.schedule(flow.nextBackgroundUs, { type: 'background', flowId });
    }
  }

  private recover(flowId: string): void {
    const flow = this.flows.get(flowId);
    if (!flow) return;
    const dcqcn = flow.dataSource.nic.dcqcn;
    const oldRate = flow.rate;
    if (flow.rate < flow.targetRate) {
      flow.rate = Math.min(flow.targetRate, flow.rate + dcqcn.rateIncreaseGbps);
    } else if (flow.rate < flow.maxRate) {
      flow.targetRate = Math.min(flow.maxRate, flow.targetRate + dcqcn.rateIncreaseGbps);
      flow.rate = Math.min(flow.targetRate, flow.rate + dcqcn.rateIncreaseGbps);
    }
    flow.alpha = Math.max(0, flow.alpha * (1 - dcqcn.alphaGain));
    if (flow.rate > oldRate + 1e-9) {
      this.emit('rate-up', `恢复定时器将速率 ${oldRate.toFixed(2)} → ${flow.rate.toFixed(2)} Gbit/s。`, {
        nodeId: flow.dataSource.id, flowId, value: flow.rate,
      });
    }
    const next = this.now + dcqcn.recoveryIntervalUs;
    if (next <= this.config.settings.durationUs) this.schedule(next, { type: 'recovery', flowId });
  }

  private retransmit(flowId: string, operationId: number): void {
    const flow = this.flows.get(flowId);
    const operation = flow?.operations.get(operationId);
    if (!flow || !operation || operation.phase === 'done') return;
    const deadline = operation.lastActivityUs + this.config.settings.retransmissionTimeoutUs;
    if (this.now + 1e-7 < deadline) {
      this.schedule(deadline, { type: 'rto', flowId, operationId });
      return;
    }
    if (operation.retries >= MAX_RETRANSMISSIONS || this.frameLimited) {
      if (!flow.warnedRetryLimit) {
        flow.warnedRetryLimit = true;
        this.emit('warning', '操作达到重传或帧预算上限，保持未完成状态。', { flowId });
      }
      return;
    }
    operation.retries += 1;
    flow.retransmissions += 1;
    operation.lastActivityUs = this.now;
    this.emit('retransmit', `RTO 到期，重传 NFS 操作 #${operation.id}（第 ${operation.retries} 次）。`, {
      flowId, nodeId: flow.compute.id, value: operation.retries,
    });
    if (operation.phase === 'request') this.sendControl(flow, operation, 'request');
    else if (operation.phase === 'ready') this.sendControl(flow, operation, 'ready');
    else if (operation.phase === 'data') this.queueData(flow, operation);
    else if (operation.phase === 'ack') this.sendControl(flow, operation, 'ack');
    this.schedule(this.now + this.config.settings.retransmissionTimeoutUs, { type: 'rto', flowId, operationId });
  }

  private deliver(packet: Packet): void {
    const flow = packet.flowId ? this.flows.get(packet.flowId) : undefined;
    if (!flow) return;
    if (packet.kind === 'background') {
      flow.deliveredBytes += packet.bytes;
      flow.intervalDeliveredBytes += packet.bytes;
      this.goodputBytes += packet.bytes;
      return;
    }
    if (packet.kind === 'data') {
      if (packet.marked) this.generateCnp(flow);
      const operation = packet.operationId === undefined ? undefined : flow.operations.get(packet.operationId);
      if (!operation || (operation.phase !== 'data' && operation.phase !== 'ack')) return;
      operation.lastActivityUs = this.now;
      const frameIndex = packet.frameIndex ?? 0;
      if (!operation.receivedFrames.has(frameIndex)) {
        operation.receivedFrames.add(frameIndex);
        operation.receivedBytes += packet.bytes;
        flow.deliveredBytes += packet.bytes;
        flow.intervalDeliveredBytes += packet.bytes;
        this.goodputBytes += packet.bytes;
      }
      if (operation.receivedBytes >= operation.bytes && !operation.ackSent) {
        operation.ackSent = true;
        operation.phase = 'ack';
        this.sendControl(flow, operation, 'ack');
      }
      return;
    }
    if (packet.kind !== 'control' || packet.operationId === undefined) return;
    const operation = flow.operations.get(packet.operationId);
    if (!operation || operation.phase === 'done') return;
    operation.lastActivityUs = this.now;
    if (packet.controlKind === 'request') {
      if (operation.phase === 'request') {
        if (flow.read) {
          operation.phase = 'data';
          this.queueData(flow, operation);
        } else {
          operation.phase = 'ready';
          this.sendControl(flow, operation, 'ready');
        }
      } else if (operation.phase === 'ready' && !flow.read) {
        this.sendControl(flow, operation, 'ready');
      }
    } else if (packet.controlKind === 'ready' && operation.phase === 'ready') {
      operation.phase = 'data';
      this.queueData(flow, operation);
    } else if (packet.controlKind === 'ack' && operation.phase === 'ack') {
      operation.phase = 'done';
      flow.operations.delete(operation.id);
      const operationRttUs = this.now - operation.createdUs;
      this.operationRttsUs.push(operationRttUs);
      flow.rttUs = flow.rttUs === 0 ? operationRttUs : flow.rttUs * 0.8 + operationRttUs * 0.2;
      if (flow.generatedBytes >= flow.totalBytes && !flow.operations.size && !flow.completed) {
        flow.completed = true;
        this.emit('flow-complete', '所有 NFS 数据已接收并完成 ACK。', { flowId: flow.config.id, value: flow.rttUs });
      } else {
        this.scheduleIssue(flow, this.now);
      }
    }
  }

  private generateCnp(flow: FlowRuntime): void {
    const interval = flow.dataSource.nic.dcqcn.cnpIntervalUs;
    if (this.now - flow.lastCnpUs < interval) return;
    flow.lastCnpUs = this.now;
    this.cnpCount += 1;
    const packet = this.createPacket({
      flowId: flow.config.id,
      kind: 'cnp',
      priority: 7,
      bytes: 64,
      route: flow.routes.ack,
    });
    this.sendRoute(packet);
    this.emit('cnp', '接收端观察到 ECN 标记，按 CNP 间隔限速后通知数据发送端。', {
      nodeId: flow.dataReceiver.id, flowId: flow.config.id, priority: 7,
    });
  }

  private captureMetrics(timeUs: number): void {
    const interval = Math.max(0, timeUs - this.lastSampleUs);
    const linkMetrics: Record<string, LinkMetric> = {};
    let maxQueueKb = 0;
    let activePauses = 0;
    for (const link of this.config.links) {
      const runtime = this.links.get(link.id);
      const directed = [...this.ports.values()].filter((port) => port.link.id === link.id);
      const queueKb = directed.reduce((max, port) => Math.max(max, port.bytes / KB), 0);
      const inputQueueKb = directed.reduce((sum, port) => sum + port.ingressBytes / KB, 0);
      let pausedMask = 0;
      for (const port of directed) {
        for (const priority of PRIORITIES) {
          if (port.pauseSources[priority].size) pausedMask |= 1 << priority;
        }
      }
      maxQueueKb = Math.max(maxQueueKb, queueKb, inputQueueKb);
      linkMetrics[link.id] = {
        utilizationGbps: gbps(runtime?.intervalBytes ?? 0, interval),
        goodputGbps: gbps(runtime?.intervalGoodputBytes ?? 0, interval),
        queueKb,
        inputQueueKb,
        ecnMarks: runtime?.ecnMarks ?? 0,
        drops: runtime?.drops ?? 0,
        pfcPauses: runtime?.pfcPauses ?? 0,
        pausedMask,
      };
      if (runtime) {
        runtime.intervalBytes = 0;
        runtime.intervalGoodputBytes = 0;
      }
    }
    for (const port of this.ports.values()) {
      for (const priority of PRIORITIES) if (port.pauseSources[priority].size) activePauses += 1;
    }
    const flowMetrics: Record<string, FlowMetric> = {};
    let intervalGoodputBytes = 0;
    for (const [flowId, flow] of this.flows) {
      intervalGoodputBytes += flow.intervalDeliveredBytes;
      flowMetrics[flowId] = {
        rateGbps: flow.rate,
        targetRateGbps: flow.targetRate,
        goodputGbps: gbps(flow.intervalDeliveredBytes, interval),
        alpha: flow.alpha,
        deliveredMb: flow.deliveredBytes / MB,
        progress: flow.totalBytes > 0 ? clamp(flow.deliveredBytes / flow.totalBytes, 0, 1) : 0,
        retransmissions: flow.retransmissions,
        rttUs: flow.rttUs,
        completed: flow.completed,
        active: flow.started && (!flow.completed || flow.backgroundScheduled),
      };
      flow.intervalDeliveredBytes = 0;
    }
    const totals = this.totalCounters();
    this.frames.push({
      timeUs,
      links: linkMetrics,
      flows: flowMetrics,
      total: {
        offeredGbps: gbps(this.intervalOfferedBytes, interval),
        goodputGbps: gbps(intervalGoodputBytes, interval),
        maxQueueKb,
        ecnMarks: totals.ecnMarks,
        drops: totals.drops,
        pfcPauses: totals.pfcPauses,
        activePauses,
      },
    });
    this.intervalOfferedBytes = 0;
    this.lastSampleUs = timeUs;
  }

  private totalCounters(): { ecnMarks: number; drops: number; pfcPauses: number } {
    let ecnMarks = 0;
    let drops = 0;
    let pfcPauses = 0;
    for (const link of this.links.values()) {
      ecnMarks += link.ecnMarks;
      drops += link.drops;
      pfcPauses += link.pfcPauses;
    }
    return { ecnMarks, drops, pfcPauses };
  }

  private makeSummary(): SimulationResult['summary'] {
    const counters = this.totalCounters();
    let pfcBusyUs = 0;
    for (const port of this.ports.values()) {
      for (const priority of PRIORITIES) {
        pfcBusyUs += port.pfcBusyUs[priority];
        if (port.pauseSources[priority].size) pfcBusyUs += Math.max(0, this.now - port.pauseSince[priority]);
      }
    }
    const completedFlows = [...this.flows.values()].filter((flow) => flow.completed).length;
    const retransmissions = [...this.flows.values()].reduce((sum, flow) => sum + flow.retransmissions, 0);
    const sortedRtts = [...this.operationRttsUs].sort((a, b) => a - b);
    const averageRttUs = sortedRtts.length ? sortedRtts.reduce((sum, value) => sum + value, 0) / sortedRtts.length : 0;
    const p95RttUs = sortedRtts.length ? sortedRtts[Math.min(sortedRtts.length - 1, Math.ceil(sortedRtts.length * 0.95) - 1)] : 0;
    const maxRttUs = sortedRtts.at(-1) ?? 0;
    const insights: string[] = [];
    const convergence = calculateConvergence(this.config);
    if (convergence.some((item) => item.ratio > 1)) insights.push('Leaf 接入带宽高于上行带宽，微突发时上行是首要拥塞观察点。');
    if (counters.ecnMarks > 0) insights.push(`共标记 ${counters.ecnMarks} 个 ECN 帧，并产生 ${this.cnpCount} 个限速 CNP。`);
    if (sortedRtts.length) insights.push(`NFS 操作平均时延 ${(averageRttUs / 1000).toFixed(2)} ms，P95 ${(p95RttUs / 1000).toFixed(2)} ms。`);
    if (counters.drops > 0) insights.push(`发生 ${counters.drops} 次丢包和 ${retransmissions} 次 RTO 重传；可检查 PFC、headroom 与缓冲。`);
    if (counters.pfcPauses > 0) insights.push(`PFC 触发 ${counters.pfcPauses} 次，暂停会逐跳传播背压，也可能造成队头阻塞。`);
    if (!counters.ecnMarks && !counters.drops && !counters.pfcPauses) insights.push('未观察到明显拥塞；可缩小 ECN/PFC 门限或提高突发强度进行对比。');
    if (this.cancelled) insights.push('本次结果由用户取消，指标仅覆盖已执行的时间片。');
    if (this.eventLimited || this.frameLimited) insights.push('达到教学仿真安全上限，结果被截断；可增大聚合帧或缩短时长。');
    if (completedFlows === this.flows.size && this.flows.size > 0) insights.push('所有启用的 NFS 文件业务均完成请求、数据和 ACK 闭环。');
    return {
      durationUs: this.now,
      offeredGbps: gbps(this.offeredBytes, this.now),
      goodputGbps: gbps(this.goodputBytes, this.now),
      peakQueueKb: this.peakQueueKb,
      ecnMarks: counters.ecnMarks,
      cnpCount: this.cnpCount,
      drops: counters.drops,
      retransmissions,
      pfcPauses: counters.pfcPauses,
      pfcBusyUs,
      averageRttUs,
      p95RttUs,
      maxRttUs,
      completedFlows,
      totalFlows: this.flows.size,
      convergence,
      insights,
    };
  }
}
