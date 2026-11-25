export type NodeKind = 'compute' | 'storage' | 'leaf' | 'spine';
export type DeviceKind = 'server' | 'switch';
export type Priority = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
export type TrafficTemplate = 'read-sequential' | 'write-sequential' | 'read-microburst' | 'write-microburst' | 'mixed-background';
export type PlaybackSpeed = 0.1 | 0.5 | 1 | 10 | 100;

export interface PfcConfig {
  enabled: boolean;
  priorities: Priority[];
  xoffKb: number;
  xonKb: number;
  headroomKb: number;
}

export interface EcnConfig {
  enabled: boolean;
  priorities: Priority[];
  minKb: number;
  maxKb: number;
  maxProbability: number;
}

export interface DcqcnConfig {
  enabled: boolean;
  initialRateGbps: number;
  minRateGbps: number;
  maxRateGbps: number;
  alpha: number;
  alphaGain: number;
  rateIncreaseGbps: number;
  recoveryIntervalUs: number;
  cnpIntervalUs: number;
}

export interface DwrrConfig {
  enabled: boolean;
  weights: Record<Priority, number>;
  controlStrictPriority: boolean;
}

export interface NicConfig {
  rateGbps: number;
  mtuBytes: number;
  rocePriority: Priority;
  dcqcn: DcqcnConfig;
  pfc: PfcConfig;
  dwrr: DwrrConfig;
}

export interface SwitchConfig {
  bufferPerPortKb: number;
  sharedBufferKb: number;
  sharedBufferEnabled: boolean;
  tailDropMode: 'dynamic' | 'static';
  dynamicAlpha: number;
  staticWatermarkKb: number;
  switchingDelayUs: number;
  ecn: EcnConfig;
  pfc: PfcConfig;
  dwrr: DwrrConfig;
}

export interface BaseNode {
  id: string;
  name: string;
  kind: NodeKind;
  device: DeviceKind;
  x: number;
  y: number;
}

export interface ServerNode extends BaseNode {
  device: 'server';
  kind: 'compute' | 'storage';
  nic: NicConfig;
  serviceLimitGbps: number;
}

export interface SwitchNode extends BaseNode {
  device: 'switch';
  kind: 'leaf' | 'spine';
  switch: SwitchConfig;
}

export type NetworkNode = ServerNode | SwitchNode;

export interface NetworkLink {
  id: string;
  name: string;
  source: string;
  target: string;
  rateGbps: number;
  propagationUs: number;
  enabled: boolean;
}

export interface TrafficFlow {
  id: string;
  name: string;
  source: string;
  target: string;
  template: TrafficTemplate;
  enabled: boolean;
  fileSizeMb: number;
  requestSizeKb: number;
  queueDepth: number;
  startTimeUs: number;
  burstIntervalUs: number;
  burstDurationUs: number;
  backgroundRateGbps: number;
  priority: Priority;
}

export interface SimulationSettings {
  durationUs: number;
  sampleIntervalUs: number;
  maxFrameBytes: number;
  retransmissionTimeoutUs: number;
  randomSeed: number;
}

export interface NetworkConfig {
  version: 1;
  name: string;
  nodes: NetworkNode[];
  links: NetworkLink[];
  flows: TrafficFlow[];
  settings: SimulationSettings;
}

export interface LinkMetric {
  utilizationGbps: number;
  goodputGbps: number;
  queueKb: number;
  inputQueueKb: number;
  ecnMarks: number;
  drops: number;
  pfcPauses: number;
  pausedMask: number;
}

export interface FlowMetric {
  rateGbps: number;
  targetRateGbps: number;
  goodputGbps: number;
  alpha: number;
  deliveredMb: number;
  progress: number;
  retransmissions: number;
  rttUs: number;
  completed: boolean;
  active: boolean;
}

export interface MetricFrame {
  timeUs: number;
  links: Record<string, LinkMetric>;
  flows: Record<string, FlowMetric>;
  total: {
    offeredGbps: number;
    goodputGbps: number;
    maxQueueKb: number;
    ecnMarks: number;
    drops: number;
    pfcPauses: number;
    activePauses: number;
  };
}

export type SimulationEventType =
  | 'ecn'
  | 'cnp'
  | 'pfc-on'
  | 'pfc-off'
  | 'drop'
  | 'retransmit'
  | 'rate-down'
  | 'rate-up'
  | 'flow-start'
  | 'flow-complete'
  | 'warning';

export interface SimulationEvent {
  id: number;
  timeUs: number;
  type: SimulationEventType;
  nodeId?: string;
  linkId?: string;
  flowId?: string;
  priority?: Priority;
  message: string;
  value?: number;
}

export interface PacketTrace {
  id: number;
  timeUs: number;
  endUs: number;
  linkId: string;
  fromNodeId: string;
  toNodeId: string;
  flowId?: string;
  kind: 'data' | 'control' | 'cnp' | 'pfc' | 'background';
  priority: Priority;
  marked: boolean;
}

export interface ConvergenceInfo {
  nodeId: string;
  accessGbps: number;
  uplinkGbps: number;
  ratio: number;
  label: string;
}

export interface SimulationSummary {
  durationUs: number;
  offeredGbps: number;
  goodputGbps: number;
  peakQueueKb: number;
  ecnMarks: number;
  cnpCount: number;
  drops: number;
  retransmissions: number;
  pfcPauses: number;
  pfcBusyUs: number;
  averageRttUs: number;
  p95RttUs: number;
  maxRttUs: number;
  completedFlows: number;
  totalFlows: number;
  convergence: ConvergenceInfo[];
  insights: string[];
}

export interface SimulationResult {
  frames: MetricFrame[];
  events: SimulationEvent[];
  traces: PacketTrace[];
  summary: SimulationSummary;
}

export interface ValidationIssue {
  severity: 'error' | 'warning';
  nodeId?: string;
  linkId?: string;
  flowId?: string;
  message: string;
}

export const PRIORITIES = [0, 1, 2, 3, 4, 5, 6, 7] as const;

export function emptyWeights(roceWeight = 70): Record<Priority, number> {
  return { 0: 30, 1: 0, 2: 0, 3: roceWeight, 4: 0, 5: 0, 6: 0, 7: 0 };
}

export const defaultDcqcn = (): DcqcnConfig => ({
  enabled: true,
  initialRateGbps: 100,
  minRateGbps: 1,
  maxRateGbps: 100,
  alpha: 0.2,
  alphaGain: 0.5,
  rateIncreaseGbps: 5,
  recoveryIntervalUs: 50,
  cnpIntervalUs: 20,
});

export const defaultPfc = (): PfcConfig => ({
  enabled: true,
  priorities: [3],
  xoffKb: 256,
  xonKb: 96,
  headroomKb: 64,
});

export const defaultEcn = (): EcnConfig => ({
  enabled: true,
  priorities: [3],
  minKb: 64,
  maxKb: 256,
  maxProbability: 1,
});

export const defaultDwrr = (): DwrrConfig => ({
  enabled: true,
  weights: emptyWeights(),
  controlStrictPriority: true,
});
