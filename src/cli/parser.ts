import type {
  NetworkConfig,
  NetworkLink,
  NetworkNode,
  Priority,
  ServerNode,
  SimulationResult,
  SwitchNode,
} from '../sim/types';

const HELP = `RoCE-Trainer 中文 CE 风格教学 CLI（教学子集，并非完整华为命令实现）
通用：
  help | ?
  system-view
  sysname <名称>
  display current-configuration
  display dcb
  display interface [接口名]
  display qos queue statistics
  interface <100GE|25GE|40GE|200GE|400GE接口名>
链路视图（interface 后的后续命令）：
  rate <Gbps>
  shutdown | undo shutdown
交换机与服务器 NIC：
  priority <0-7> pfc enable|disable
  pfc xoff <KB> xon <KB>
  dcb pfc enable|disable（也支持 undo dcb pfc enable）
交换机：
  ecn enable|disable
  ecn priority <0-7> low-limit <KB> high-limit <KB> [probability <0-1>]
  dwrr priority <0-7> weight <非负整数>
  buffer shared <KB> | buffer port <KB>
  buffer tail-drop dynamic alpha <值> | buffer tail-drop static <KB>
  dcb ecn enable|disable | dcb ets enable|disable（均支持 undo ... enable）
服务器：
  dcqcn enable|disable
  dcqcn alpha <0-1>
  dcqcn min-rate <Gbps> max-rate <Gbps>
  dcqcn recovery-interval <us>
  mtu <bytes>
  roce priority <0-7>
说明：可在一次输入中写多行；接口上下文只作用于本次输入中 interface 之后的命令。`;

const INTERFACE_NAME = /^(?:100GE|25GE|40GE|200GE|400GE)[\w/:.:-]+$/i;
const INTERFACE_TYPE = /^(?:100GE|25GE|40GE|200GE|400GE)$/i;
const DECIMAL = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;

class CommandError extends Error {}

interface CommandContext {
  link?: NetworkLink;
}

function cloneConfig(config: NetworkConfig): NetworkConfig {
  return {
    ...config,
    nodes: config.nodes.map((node): NetworkNode => {
      if (node.device === 'server') {
        return {
          ...node,
          nic: {
            ...node.nic,
            pfc: { ...node.nic.pfc, priorities: [...node.nic.pfc.priorities] },
            dwrr: { ...node.nic.dwrr, weights: { ...node.nic.dwrr.weights } },
            dcqcn: { ...node.nic.dcqcn },
          },
        };
      }
      return {
        ...node,
        switch: {
          ...node.switch,
          pfc: { ...node.switch.pfc, priorities: [...node.switch.pfc.priorities] },
          ecn: { ...node.switch.ecn, priorities: [...node.switch.ecn.priorities] },
          dwrr: { ...node.switch.dwrr, weights: { ...node.switch.dwrr.weights } },
        },
      };
    }),
    links: config.links.map((link) => ({ ...link })),
    flows: config.flows.map((flow) => ({ ...flow })),
    settings: { ...config.settings },
  };
}

function numberValue(token: string, label: string): number {
  if (!DECIMAL.test(token)) {
    throw new CommandError(`${label}必须是十进制数字，收到“${token}”。`);
  }
  const value = Number(token);
  if (!Number.isFinite(value)) {
    throw new CommandError(`${label}必须是有限数字，收到“${token}”。`);
  }
  return value;
}

function integerValue(token: string, label: string): number {
  const value = numberValue(token, label);
  if (!Number.isInteger(value)) {
    throw new CommandError(`${label}必须是整数，收到“${token}”。`);
  }
  return value;
}

function positiveValue(token: string, label: string): number {
  const value = numberValue(token, label);
  if (value <= 0) {
    throw new CommandError(`${label}必须大于 0，收到“${token}”。`);
  }
  return value;
}

function nonNegativeInteger(token: string, label: string): number {
  const value = integerValue(token, label);
  if (value < 0) {
    throw new CommandError(`${label}不能小于 0，收到“${token}”。`);
  }
  return value;
}

function priorityValue(token: string): Priority {
  const value = integerValue(token, '优先级');
  if (value < 0 || value > 7) {
    throw new CommandError(`优先级必须在 0-7 之间，收到“${token}”。`);
  }
  return value as Priority;
}

function probabilityValue(token: string, label: string): number {
  const value = numberValue(token, label);
  if (value < 0 || value > 1) {
    throw new CommandError(`${label}必须在 0-1 之间（含边界），收到“${token}”。`);
  }
  return value;
}

function requireArity(words: string[], count: number, usage: string): void {
  if (words.length !== count) {
    throw new CommandError(`命令格式错误。用法：${usage}`);
  }
}

function requireSwitch(node: NetworkNode, command: string): SwitchNode {
  if (node.device !== 'switch') {
    throw new CommandError(`命令“${command}”仅适用于交换机；当前节点“${node.id}”是服务器。`);
  }
  return node;
}

function requireServer(node: NetworkNode, command: string): ServerNode {
  if (node.device !== 'server') {
    throw new CommandError(`命令“${command}”仅适用于服务器 NIC；当前节点“${node.id}”是交换机。`);
  }
  return node;
}

function attachedLinks(config: NetworkConfig, nodeId: string): NetworkLink[] {
  return config.links.filter((link) => link.source === nodeId || link.target === nodeId);
}

function interfaceArgument(words: string[], start: number, usage: string): string {
  if (words.length === start + 1) {
    return words[start];
  }
  if (words.length === start + 2 && INTERFACE_TYPE.test(words[start])) {
    return `${words[start]}${words[start + 1]}`;
  }
  throw new CommandError(`命令格式错误。用法：${usage}`);
}

function findInterface(config: NetworkConfig, node: NetworkNode, name: string): NetworkLink {
  if (!INTERFACE_NAME.test(name)) {
    throw new CommandError(
      `接口名“${name}”无效；仅支持 100GE、25GE、40GE、200GE、400GE 名称，例如 100GE0/0/1。`,
    );
  }
  const link = attachedLinks(config, node.id).find(
    (candidate) => candidate.name.toLowerCase() === name.toLowerCase(),
  );
  if (!link) {
    throw new CommandError(
      `节点“${node.id}”上不存在接口“${name}”；请用 display interface 查看该设备的接口。`,
    );
  }
  return link;
}

function selectedLink(context: CommandContext, usage: string): NetworkLink {
  if (!context.link) {
    throw new CommandError(`该命令需要链路上下文；请先执行 interface <接口名>，再执行 ${usage}。`);
  }
  return context.link;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)));
}

function prioritiesText(priorities: Priority[]): string {
  return priorities.length === 0 ? '无' : [...priorities].sort((a, b) => a - b).join(',');
}

function enabledText(enabled: boolean): string {
  return enabled ? '启用' : '禁用';
}

function peerText(config: NetworkConfig, nodeId: string, link: NetworkLink): string {
  const peerId = link.source === nodeId ? link.target : link.source;
  const peer = config.nodes.find((node) => node.id === peerId);
  return peer ? `${peer.name}(${peer.id})` : peerId;
}

function interfaceTable(config: NetworkConfig, node: NetworkNode, links: NetworkLink[]): string {
  if (links.length === 0) {
    return `节点“${node.id}”没有可显示的接入接口。`;
  }
  const rows = links.map((link) => {
    const direction = link.source === node.id ? '发出' : '接入';
    return [
      link.name,
      direction,
      peerText(config, node.id, link),
      formatNumber(link.rateGbps),
      link.enabled ? '已启用' : '已关闭',
    ].join(' | ');
  });
  return [
    `接口信息（节点 ${node.name}/${node.id}，共 ${links.length} 条链路）：`,
    '接口 | 方向 | 对端 | 速率(Gbps) | 状态',
    '--- | --- | --- | ---: | ---',
    ...rows,
  ].join('\n');
}

function currentConfiguration(config: NetworkConfig, node: NetworkNode): string {
  const lines = [
    `当前配置（${node.device === 'switch' ? '交换机' : '服务器'}，教学子集）：`,
    `节点 ID：${node.id}`,
    `sysname ${node.name}`,
  ];
  if (node.device === 'server') {
    const { nic } = node;
    lines.push(
      `NIC 速率：${formatNumber(nic.rateGbps)} Gbps；MTU：${nic.mtuBytes} bytes；RoCE 优先级：${nic.rocePriority}`,
      `PFC：${enabledText(nic.pfc.enabled)}；优先级：${prioritiesText(nic.pfc.priorities)}；xoff/xon：${formatNumber(nic.pfc.xoffKb)}/${formatNumber(nic.pfc.xonKb)} KB；headroom：${formatNumber(nic.pfc.headroomKb)} KB`,
      `DCQCN：${enabledText(nic.dcqcn.enabled)}；alpha：${formatNumber(nic.dcqcn.alpha)}；min/max-rate：${formatNumber(nic.dcqcn.minRateGbps)}/${formatNumber(nic.dcqcn.maxRateGbps)} Gbps；recovery-interval：${formatNumber(nic.dcqcn.recoveryIntervalUs)} us`,
    );
  } else {
    const switchConfig = node.switch;
    lines.push(
      `PFC：${enabledText(switchConfig.pfc.enabled)}；优先级：${prioritiesText(switchConfig.pfc.priorities)}；xoff/xon：${formatNumber(switchConfig.pfc.xoffKb)}/${formatNumber(switchConfig.pfc.xonKb)} KB；headroom：${formatNumber(switchConfig.pfc.headroomKb)} KB`,
      `ECN：${enabledText(switchConfig.ecn.enabled)}；优先级：${prioritiesText(switchConfig.ecn.priorities)}；low/high-limit：${formatNumber(switchConfig.ecn.minKb)}/${formatNumber(switchConfig.ecn.maxKb)} KB；probability：${formatNumber(switchConfig.ecn.maxProbability)}`,
      `ETS/DWRR：${enabledText(switchConfig.dwrr.enabled)}；完整权重：${[0, 1, 2, 3, 4, 5, 6, 7].map((priority) => `${priority}=${formatNumber(switchConfig.dwrr.weights[priority as Priority])}`).join(', ')}`,
      `缓存：shared ${formatNumber(switchConfig.sharedBufferKb)} KB（${enabledText(switchConfig.sharedBufferEnabled)}）；port ${formatNumber(switchConfig.bufferPerPortKb)} KB`,
    );
  }
  lines.push('', interfaceTable(config, node, attachedLinks(config, node.id)));
  return lines.join('\n');
}

function dcbDisplay(node: NetworkNode): string {
  if (node.device === 'server') {
    const { pfc, dcqcn } = node.nic;
    return [
      `DCB/无损配置（服务器 ${node.name}/${node.id}）：`,
      `PFC：${enabledText(pfc.enabled)}；优先级：${prioritiesText(pfc.priorities)}；xoff：${formatNumber(pfc.xoffKb)} KB；xon：${formatNumber(pfc.xonKb)} KB`,
      `DCQCN：${enabledText(dcqcn.enabled)}；alpha：${formatNumber(dcqcn.alpha)}；速率范围：${formatNumber(dcqcn.minRateGbps)}-${formatNumber(dcqcn.maxRateGbps)} Gbps；恢复间隔：${formatNumber(dcqcn.recoveryIntervalUs)} us`,
      `RoCE 优先级：${node.nic.rocePriority}`,
    ].join('\n');
  }
  const { pfc, ecn, dwrr, sharedBufferKb, bufferPerPortKb, tailDropMode, staticWatermarkKb, dynamicAlpha } = node.switch;
  return [
    `DCB 配置（交换机 ${node.name}/${node.id}）：`,
    `PFC：${enabledText(pfc.enabled)}；优先级：${prioritiesText(pfc.priorities)}；xoff：${formatNumber(pfc.xoffKb)} KB；xon：${formatNumber(pfc.xonKb)} KB`,
    `ECN：${enabledText(ecn.enabled)}；优先级：${prioritiesText(ecn.priorities)}；low/high-limit：${formatNumber(ecn.minKb)}/${formatNumber(ecn.maxKb)} KB；probability：${formatNumber(ecn.maxProbability)}`,
    `ETS/DWRR：${enabledText(dwrr.enabled)}；${[0, 1, 2, 3, 4, 5, 6, 7].map((priority) => `P${priority}=${formatNumber(dwrr.weights[priority as Priority])}`).join('，')}`,
    `缓存：shared ${formatNumber(sharedBufferKb)} KB；port ${formatNumber(bufferPerPortKb)} KB；尾丢 ${tailDropMode === 'static' ? `static ${formatNumber(staticWatermarkKb)} KB` : `dynamic alpha=${formatNumber(dynamicAlpha)}`}`,
  ].join('\n');
}

function queueStatistics(
  config: NetworkConfig,
  node: NetworkNode,
  context: CommandContext,
  result?: SimulationResult,
): string {
  const links = context.link ? [context.link] : attachedLinks(config, node.id);
  if (links.length === 0) {
    return `QoS 队列统计：节点“${node.id}”没有接入链路。`;
  }
  const frame = result?.frames[result.frames.length - 1];
  if (!frame) {
    return 'QoS 队列统计：暂无仿真统计，请先运行仿真后再查询；本命令不会生成模拟数据。';
  }
  const rows = links.map((link) => {
    const metric = frame.links[link.id];
    if (!metric) {
      return `${link.name} | — | — | — | — | — | — | 无数据`;
    }
    return [
      link.name,
      formatNumber(metric.utilizationGbps),
      formatNumber(metric.goodputGbps),
      formatNumber(metric.queueKb),
      formatNumber(metric.inputQueueKb),
      metric.ecnMarks,
      metric.drops,
      metric.pfcPauses,
    ].join(' | ');
  });
  return [
    `QoS 队列统计（节点 ${node.name}/${node.id}，采样时刻 ${formatNumber(frame.timeUs)} us）：`,
    '接口 | 利用率(Gbps) | 有效吞吐(Gbps) | 队列(KB) | 输入队列(KB) | ECN标记 | 丢包 | PFC暂停',
    '--- | ---: | ---: | ---: | ---: | ---: | ---: | ---:',
    ...rows,
  ].join('\n');
}

function displayCommand(
  config: NetworkConfig,
  node: NetworkNode,
  words: string[],
  context: CommandContext,
  result?: SimulationResult,
): string {
  const target = words[1]?.toLowerCase();
  if (target === 'current-configuration') {
    requireArity(words, 2, 'display current-configuration');
    return currentConfiguration(config, node);
  }
  if (target === 'dcb') {
    requireArity(words, 2, 'display dcb');
    return dcbDisplay(node);
  }
  if (target === 'interface') {
    if (words.length === 2) {
      return interfaceTable(config, node, attachedLinks(config, node.id));
    }
    const name = interfaceArgument(words, 2, 'display interface [接口名]');
    return interfaceTable(config, node, [findInterface(config, node, name)]);
  }
  if (target === 'qos') {
    requireArity(words, 4, 'display qos queue statistics');
    if (words[2].toLowerCase() !== 'queue' || words[3].toLowerCase() !== 'statistics') {
      throw new CommandError('仅支持 display qos queue statistics；请先运行仿真以获取统计。');
    }
    return queueStatistics(config, node, context, result);
  }
  throw new CommandError('不支持的 display 子命令。可用：current-configuration、dcb、interface、qos queue statistics。');
}

function dcbAlias(node: NetworkNode, words: string[], undo: boolean): string {
  const offset = undo ? 1 : 0;
  const usage = undo
    ? 'undo dcb <pfc|ecn|ets> enable'
    : 'dcb <pfc|ecn|ets> enable|disable';
  if (words.length !== offset + 3 || words[offset].toLowerCase() !== 'dcb') {
    throw new CommandError(`命令格式错误。用法：${usage}`);
  }
  const feature = words[offset + 1].toLowerCase();
  const action = words[offset + 2].toLowerCase();
  if ((action !== 'enable' && action !== 'disable') || (undo && action !== 'enable')) {
    throw new CommandError(`命令格式错误。用法：${usage}`);
  }
  const enabled = undo ? false : action === 'enable';
  if (feature === 'pfc') {
    const pfc = node.device === 'server' ? node.nic.pfc : node.switch.pfc;
    pfc.enabled = enabled;
    return `已通过 DCB 别名${enabledText(enabled)} PFC（节点 ${node.id}）。`;
  }
  if (feature === 'ecn') {
    const switchNode = requireSwitch(node, 'dcb ecn');
    switchNode.switch.ecn.enabled = enabled;
    return `已通过 DCB 别名${enabledText(enabled)} ECN（节点 ${node.id}）。`;
  }
  if (feature === 'ets') {
    const switchNode = requireSwitch(node, 'dcb ets');
    switchNode.switch.dwrr.enabled = enabled;
    return `已通过 DCB 别名${enabledText(enabled)} ETS/DWRR（节点 ${node.id}）。`;
  }
  throw new CommandError(`不支持的 DCB 别名“${feature}”；仅支持 pfc、ecn、ets。`);
}

function executeLine(
  config: NetworkConfig,
  node: NetworkNode,
  words: string[],
  context: CommandContext,
  result?: SimulationResult,
): string {
  const lower = words.map((word) => word.toLowerCase());
  const command = lower[0];

  if (command === 'help' || command === '?') {
    requireArity(words, 1, 'help 或 ?');
    return HELP;
  }
  if (command === 'system-view') {
    requireArity(words, 1, 'system-view');
    return '系统视图提示：本模块是中文 CE 风格教学子集，不保持完整设备视图状态；请继续输入配置或 display 命令。';
  }
  if (command === 'sysname') {
    requireArity(words, 2, 'sysname <名称>');
    if ([...words[1]].length > 64) {
      throw new CommandError('系统名称不能超过 64 个字符。');
    }
    node.name = words[1];
    return `已将节点 ${node.id} 的系统名称设置为“${node.name}”。`;
  }
  if (command === 'display') {
    return displayCommand(config, node, words, context, result);
  }
  if (command === 'interface') {
    const name = interfaceArgument(words, 1, 'interface <100GE|25GE|40GE|200GE|400GE接口名>');
    context.link = findInterface(config, node, name);
    return `已进入接口视图：${context.link.name}（节点 ${node.id}）；后续 rate、shutdown、undo shutdown 和队列统计将作用于该链路。`;
  }
  if (command === 'shutdown') {
    requireArity(words, 1, 'shutdown');
    const link = selectedLink(context, 'shutdown');
    link.enabled = false;
    return `已关闭接口 ${link.name}（链路 ${link.id}，enabled=false）。`;
  }
  if (command === 'undo' && lower[1] === 'shutdown') {
    requireArity(words, 2, 'undo shutdown');
    const link = selectedLink(context, 'undo shutdown');
    link.enabled = true;
    return `已启用接口 ${link.name}（链路 ${link.id}，enabled=true）。`;
  }
  if (command === 'rate') {
    requireArity(words, 2, 'rate <Gbps>');
    const link = selectedLink(context, 'rate <Gbps>');
    const rate = positiveValue(words[1], '链路速率');
    link.rateGbps = rate;
    return `已将接口 ${link.name} 的链路速率设置为 ${formatNumber(rate)} Gbps。`;
  }
  if (command === 'priority') {
    requireArity(words, 4, 'priority <0-7> pfc enable|disable');
    if (lower[2] !== 'pfc' || (lower[3] !== 'enable' && lower[3] !== 'disable')) {
      throw new CommandError('命令格式错误。用法：priority <0-7> pfc enable|disable');
    }
    const priority = priorityValue(words[1]);
    const enabled = lower[3] === 'enable';
    const pfc = node.device === 'server' ? node.nic.pfc : node.switch.pfc;
    const priorities = new Set(pfc.priorities);
    if (enabled) {
      priorities.add(priority);
      pfc.enabled = true;
    } else {
      priorities.delete(priority);
      if (priorities.size === 0) {
        pfc.enabled = false;
      }
    }
    pfc.priorities = [...priorities].sort((a, b) => a - b);
    return `已${enabled ? '启用' : '禁用'}优先级 ${priority} 的 PFC；当前 PFC 优先级：${prioritiesText(pfc.priorities)}，全局状态：${enabledText(pfc.enabled)}。`;
  }
  if (command === 'pfc') {
    requireArity(words, 5, 'pfc xoff <KB> xon <KB>');
    if (lower[1] !== 'xoff' || lower[3] !== 'xon') {
      throw new CommandError('命令格式错误。用法：pfc xoff <KB> xon <KB>');
    }
    const xoff = positiveValue(words[2], 'PFC xoff');
    const xon = nonNegativeInteger(words[4], 'PFC xon');
    if (!Number.isInteger(xoff)) {
      throw new CommandError(`PFC xoff 必须是整数 KB，收到“${words[2]}”。`);
    }
    if (xon >= xoff) {
      throw new CommandError(`PFC xon 必须小于 xoff（当前 xon=${formatNumber(xon)} KB，xoff=${formatNumber(xoff)} KB）。`);
    }
    const pfc = node.device === 'server' ? node.nic.pfc : node.switch.pfc;
    pfc.xoffKb = xoff;
    pfc.xonKb = xon;
    return `已设置 PFC 门限：xoff=${formatNumber(xoff)} KB，xon=${formatNumber(xon)} KB。`;
  }
  if (command === 'dcb') {
    return dcbAlias(node, words, false);
  }
  if (command === 'undo' && lower[1] === 'dcb') {
    return dcbAlias(node, words, true);
  }
  if (command === 'ecn') {
    const switchNode = requireSwitch(node, 'ecn');
    if (lower[1] === 'enable' || lower[1] === 'disable') {
      requireArity(words, 2, 'ecn enable|disable');
      switchNode.switch.ecn.enabled = lower[1] === 'enable';
      return `已${enabledText(switchNode.switch.ecn.enabled)}交换机 ECN。`;
    }
    if (lower[1] !== 'priority' || (words.length !== 7 && words.length !== 9)) {
      throw new CommandError('命令格式错误。用法：ecn priority <0-7> low-limit <KB> high-limit <KB> [probability <0-1>]');
    }
    if (lower[3] !== 'low-limit' || lower[5] !== 'high-limit' || (words.length === 9 && lower[7] !== 'probability')) {
      throw new CommandError('ECN 参数顺序错误。用法：ecn priority <0-7> low-limit <KB> high-limit <KB> [probability <0-1>]');
    }
    const priority = priorityValue(words[2]);
    const low = nonNegativeInteger(words[4], 'ECN low-limit');
    const high = nonNegativeInteger(words[6], 'ECN high-limit');
    if (high === 0 || low >= high) {
      throw new CommandError(`ECN 门限必须满足 0 <= low-limit < high-limit（当前 ${low}/${high} KB）。`);
    }
    const probability = words.length === 9
      ? probabilityValue(words[8], 'ECN probability')
      : switchNode.switch.ecn.maxProbability;
    const { ecn } = switchNode.switch;
    ecn.priorities = [...new Set([...ecn.priorities, priority])].sort((a, b) => a - b);
    ecn.minKb = low;
    ecn.maxKb = high;
    ecn.maxProbability = probability;
    ecn.enabled = true;
    return `已配置并启用 ECN：priority=${priority}，low-limit=${low} KB，high-limit=${high} KB，probability=${formatNumber(probability)}。`;
  }
  if (command === 'dwrr') {
    const switchNode = requireSwitch(node, 'dwrr');
    requireArity(words, 5, 'dwrr priority <0-7> weight <非负整数>');
    if (lower[1] !== 'priority' || lower[3] !== 'weight') {
      throw new CommandError('命令格式错误。用法：dwrr priority <0-7> weight <非负整数>');
    }
    const priority = priorityValue(words[2]);
    const weight = nonNegativeInteger(words[4], 'DWRR weight');
    switchNode.switch.dwrr.weights[priority] = weight;
    switchNode.switch.dwrr.enabled = true;
    return `已启用 ETS/DWRR，并设置优先级 ${priority} 的权重为 ${weight}。`;
  }
  if (command === 'buffer') {
    const switchNode = requireSwitch(node, 'buffer');
    requireArity(words, 3, 'buffer shared <KB> 或 buffer port <KB>');
    const size = nonNegativeInteger(words[2], '缓存大小');
    if (lower[1] === 'shared') {
      switchNode.switch.sharedBufferKb = size;
      switchNode.switch.sharedBufferEnabled = size > 0;
      return `已设置共享缓存为 ${size} KB（${enabledText(size > 0)}）。`;
    }
    if (lower[1] === 'port') {
      switchNode.switch.bufferPerPortKb = size;
      return `已设置每端口缓存为 ${size} KB。`;
    }
    if (lower[1] === 'tail-drop' && lower[2] === 'dynamic') {
      requireArity(words, 5, 'buffer tail-drop dynamic alpha <值>');
      switchNode.switch.tailDropMode = 'dynamic';
      switchNode.switch.dynamicAlpha = probabilityValue(words[4], 'dynamic Alpha');
      return `已设置 shared dynamic 尾丢水线（Alpha=${formatNumber(switchNode.switch.dynamicAlpha)}）。`;
    }
    if (lower[1] === 'tail-drop' && lower[2] === 'static') {
      requireArity(words, 4, 'buffer tail-drop static <KB>');
      switchNode.switch.tailDropMode = 'static';
      switchNode.switch.staticWatermarkKb = positiveValue(words[3], 'static 尾丢水线');
      return `已设置 static 尾丢水线为 ${formatNumber(switchNode.switch.staticWatermarkKb)} KB。`;
    }
    throw new CommandError('命令格式错误。用法：buffer shared <KB>、buffer port <KB> 或 buffer tail-drop dynamic|static');
  }
  if (command === 'dcqcn') {
    const server = requireServer(node, 'dcqcn');
    const { dcqcn } = server.nic;
    if (lower[1] === 'enable' || lower[1] === 'disable') {
      requireArity(words, 2, 'dcqcn enable|disable');
      dcqcn.enabled = lower[1] === 'enable';
      return `已${enabledText(dcqcn.enabled)}服务器 NIC 的 DCQCN。`;
    }
    if (lower[1] === 'alpha') {
      requireArity(words, 3, 'dcqcn alpha <0-1>');
      dcqcn.alpha = probabilityValue(words[2], 'DCQCN alpha');
      return `已设置 DCQCN alpha=${formatNumber(dcqcn.alpha)}。`;
    }
    if (lower[1] === 'recovery-interval') {
      requireArity(words, 3, 'dcqcn recovery-interval <us>');
      dcqcn.recoveryIntervalUs = positiveValue(words[2], 'DCQCN recovery-interval');
      return `已设置 DCQCN recovery-interval=${formatNumber(dcqcn.recoveryIntervalUs)} us。`;
    }
    if (lower[1] === 'min-rate') {
      requireArity(words, 5, 'dcqcn min-rate <Gbps> max-rate <Gbps>');
      if (lower[3] !== 'max-rate') {
        throw new CommandError('命令格式错误。用法：dcqcn min-rate <Gbps> max-rate <Gbps>');
      }
      const min = positiveValue(words[2], 'DCQCN min-rate');
      const max = positiveValue(words[4], 'DCQCN max-rate');
      if (min > max) {
        throw new CommandError(`DCQCN min-rate 不能大于 max-rate（当前 ${formatNumber(min)} > ${formatNumber(max)} Gbps）。`);
      }
      dcqcn.minRateGbps = min;
      dcqcn.maxRateGbps = max;
      return `已设置 DCQCN 速率范围：${formatNumber(min)}-${formatNumber(max)} Gbps。`;
    }
    throw new CommandError('不支持的 DCQCN 子命令；可用 enable/disable、alpha、min-rate/max-rate、recovery-interval。');
  }
  if (command === 'mtu') {
    const server = requireServer(node, 'mtu');
    requireArity(words, 2, 'mtu <bytes>');
    const mtu = positiveValue(words[1], 'MTU');
    if (!Number.isInteger(mtu)) {
      throw new CommandError(`MTU 必须是整数 bytes，收到“${words[1]}”。`);
    }
    server.nic.mtuBytes = mtu;
    return `已设置服务器 NIC MTU=${mtu} bytes。`;
  }
  if (command === 'roce') {
    const server = requireServer(node, 'roce priority');
    requireArity(words, 3, 'roce priority <0-7>');
    if (lower[1] !== 'priority') {
      throw new CommandError('命令格式错误。用法：roce priority <0-7>');
    }
    const priority = priorityValue(words[2]);
    server.nic.rocePriority = priority;
    return `已设置 RoCE 优先级为 ${priority}。`;
  }
  if (command === 'undo') {
    throw new CommandError('不支持的 undo 命令；教学子集仅支持 undo shutdown 和 undo dcb <pfc|ecn|ets> enable。');
  }
  throw new CommandError(`未知命令“${words[0]}”；输入 help 或 ? 查看支持的中文 CE 风格教学命令。`);
}

/**
 * 执行一个设备上的中文 CE 风格教学命令（可包含多行）。
 * 每次调用都会深拷贝配置；某一行失败不会撤销其他成功行，success 表示是否全部成功。
 */
export function executeCommand(
  config: NetworkConfig,
  nodeId: string,
  input: string,
  result?: SimulationResult,
): { config: NetworkConfig; output: string; success: boolean } {
  const originalNode = config.nodes.find((node) => node.id === nodeId);
  if (!originalNode) {
    return {
      config,
      output: `错误：不存在设备“${nodeId}”。请从 NetworkConfig.nodes 中选择有效节点 ID。`,
      success: false,
    };
  }

  const nextConfig = cloneConfig(config);
  const node = nextConfig.nodes.find((candidate) => candidate.id === nodeId)!;
  const context: CommandContext = {};
  const lines = input.split(/\r?\n/);
  const outputs: string[] = [];
  let success = true;
  let commandCount = 0;

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      return;
    }
    commandCount += 1;
    const words = trimmed.split(/\s+/);
    try {
      outputs.push(executeLine(nextConfig, node, words, context, result));
    } catch (error) {
      if (!(error instanceof CommandError)) {
        throw error;
      }
      success = false;
      outputs.push(`第 ${index + 1} 行错误：${error.message}`);
    }
  });

  if (commandCount === 0) {
    outputs.push('未输入命令；请输入 help 或 ? 查看支持的教学命令。');
  }

  return { config: nextConfig, output: outputs.join('\n\n'), success };
}
