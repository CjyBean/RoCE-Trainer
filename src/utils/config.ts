import { validateConfig } from '../sim/topology';
import type { NetworkConfig, Priority, TrafficTemplate } from '../sim/types';

type UnknownRecord = Record<string, unknown>;

const templates = new Set<TrafficTemplate>([
  'read-sequential', 'write-sequential', 'read-microburst', 'write-microburst', 'mixed-background',
]);

function fail(path: string, expectation: string): never {
  throw new Error(`${path} ${expectation}`);
}

function object(value: unknown, path: string): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, '必须是对象');
  return value as UnknownRecord;
}

function list(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, '必须是数组');
  return value;
}

function text(value: unknown, path: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) fail(path, '必须是非空字符串');
  return value;
}

function finite(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, '必须是有限数字');
  return value;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path, '必须是布尔值');
  return value;
}

function priority(value: unknown, path: string): Priority {
  const number = finite(value, path);
  if (!Number.isInteger(number) || number < 0 || number > 7) fail(path, '必须是 0…7 的整数');
  return number as Priority;
}

function priorities(value: unknown, path: string): void {
  list(value, path).forEach((item, index) => priority(item, `${path}[${index}]`));
}

function pfc(value: unknown, path: string): void {
  const item = object(value, path);
  boolean(item.enabled, `${path}.enabled`);
  priorities(item.priorities, `${path}.priorities`);
  finite(item.xoffKb, `${path}.xoffKb`);
  finite(item.xonKb, `${path}.xonKb`);
  finite(item.headroomKb, `${path}.headroomKb`);
}

function ecn(value: unknown, path: string): void {
  const item = object(value, path);
  boolean(item.enabled, `${path}.enabled`);
  priorities(item.priorities, `${path}.priorities`);
  finite(item.minKb, `${path}.minKb`);
  finite(item.maxKb, `${path}.maxKb`);
  finite(item.maxProbability, `${path}.maxProbability`);
}

function dwrr(value: unknown, path: string): void {
  const item = object(value, path);
  boolean(item.enabled, `${path}.enabled`);
  boolean(item.controlStrictPriority, `${path}.controlStrictPriority`);
  const weights = object(item.weights, `${path}.weights`);
  for (let index = 0; index < 8; index += 1) finite(weights[index], `${path}.weights.${index}`);
}

function dcqcn(value: unknown, path: string): void {
  const item = object(value, path);
  boolean(item.enabled, `${path}.enabled`);
  for (const key of ['initialRateGbps', 'minRateGbps', 'maxRateGbps', 'alpha', 'alphaGain', 'rateIncreaseGbps', 'recoveryIntervalUs', 'cnpIntervalUs']) {
    finite(item[key], `${path}.${key}`);
  }
}

function node(value: unknown, index: number): void {
  const path = `nodes[${index}]`;
  const item = object(value, path);
  text(item.id, `${path}.id`);
  text(item.name, `${path}.name`);
  finite(item.x, `${path}.x`);
  finite(item.y, `${path}.y`);
  if (item.device === 'server') {
    if (item.kind !== 'compute' && item.kind !== 'storage') fail(`${path}.kind`, '必须是 compute 或 storage');
    finite(item.serviceLimitGbps, `${path}.serviceLimitGbps`);
    const nic = object(item.nic, `${path}.nic`);
    finite(nic.rateGbps, `${path}.nic.rateGbps`);
    finite(nic.mtuBytes, `${path}.nic.mtuBytes`);
    priority(nic.rocePriority, `${path}.nic.rocePriority`);
    dcqcn(nic.dcqcn, `${path}.nic.dcqcn`);
    pfc(nic.pfc, `${path}.nic.pfc`);
    dwrr(nic.dwrr, `${path}.nic.dwrr`);
    return;
  }
  if (item.device === 'switch') {
    if (item.kind !== 'leaf' && item.kind !== 'spine') fail(`${path}.kind`, '必须是 leaf 或 spine');
    const config = object(item.switch, `${path}.switch`);
    finite(config.bufferPerPortKb, `${path}.switch.bufferPerPortKb`);
    finite(config.sharedBufferKb, `${path}.switch.sharedBufferKb`);
    boolean(config.sharedBufferEnabled, `${path}.switch.sharedBufferEnabled`);
    if (config.tailDropMode !== 'dynamic' && config.tailDropMode !== 'static') fail(`${path}.switch.tailDropMode`, '必须是 dynamic 或 static');
    finite(config.dynamicAlpha, `${path}.switch.dynamicAlpha`);
    finite(config.staticWatermarkKb, `${path}.switch.staticWatermarkKb`);
    finite(config.switchingDelayUs, `${path}.switch.switchingDelayUs`);
    ecn(config.ecn, `${path}.switch.ecn`);
    pfc(config.pfc, `${path}.switch.pfc`);
    dwrr(config.dwrr, `${path}.switch.dwrr`);
    return;
  }
  fail(`${path}.device`, '必须是 server 或 switch');
}

function link(value: unknown, index: number): void {
  const path = `links[${index}]`;
  const item = object(value, path);
  for (const key of ['id', 'name', 'source', 'target']) text(item[key], `${path}.${key}`);
  finite(item.rateGbps, `${path}.rateGbps`);
  finite(item.propagationUs, `${path}.propagationUs`);
  boolean(item.enabled, `${path}.enabled`);
}

function flow(value: unknown, index: number): void {
  const path = `flows[${index}]`;
  const item = object(value, path);
  for (const key of ['id', 'name', 'source', 'target']) text(item[key], `${path}.${key}`);
  if (typeof item.template !== 'string' || !templates.has(item.template as TrafficTemplate)) fail(`${path}.template`, '不是支持的业务模板');
  boolean(item.enabled, `${path}.enabled`);
  for (const key of ['fileSizeMb', 'requestSizeKb', 'queueDepth', 'startTimeUs', 'burstIntervalUs', 'burstDurationUs', 'backgroundRateGbps']) {
    finite(item[key], `${path}.${key}`);
  }
  priority(item.priority, `${path}.priority`);
}

/** Parse untrusted JSON/localStorage data before any UI or simulation code reads it. */
export function parseNetworkConfig(value: unknown): NetworkConfig {
  const root = object(value, '配置');
  if (root.version !== 1) fail('配置.version', '必须为 1');
  text(root.name, '配置.name');
  list(root.nodes, '配置.nodes').forEach(node);
  list(root.links, '配置.links').forEach(link);
  list(root.flows, '配置.flows').forEach(flow);
  const settings = object(root.settings, '配置.settings');
  for (const key of ['durationUs', 'sampleIntervalUs', 'maxFrameBytes', 'retransmissionTimeoutUs', 'randomSeed']) {
    finite(settings[key], `配置.settings.${key}`);
  }
  return value as NetworkConfig;
}

/** Validate both the shape and the semantic invariants of an imported/restored config. */
export function parseValidNetworkConfig(value: unknown): NetworkConfig {
  const config = parseNetworkConfig(value);
  const fatal = validateConfig(config).find((issue) => issue.severity === 'error');
  if (fatal) throw new Error(fatal.message);
  return config;
}
