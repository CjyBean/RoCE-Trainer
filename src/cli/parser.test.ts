import { describe, expect, it } from 'vitest';
import {
  defaultDcqcn,
  defaultDwrr,
  defaultEcn,
  defaultPfc,
  type NetworkConfig,
  type NetworkNode,
  type SimulationResult,
} from '../sim/types';
import { executeCommand } from './parser';

function server(id: string, name = id): NetworkNode {
  return {
    id,
    name,
    kind: 'compute',
    device: 'server',
    x: 0,
    y: 0,
    serviceLimitGbps: 100,
    nic: {
      rateGbps: 100,
      mtuBytes: 9000,
      rocePriority: 3,
      dcqcn: defaultDcqcn(),
      pfc: defaultPfc(),
      dwrr: defaultDwrr(),
    },
  };
}

function makeConfig(): NetworkConfig {
  return {
    version: 1,
    name: 'CLI 测试拓扑',
    nodes: [
      server('server-1', '计算节点一'),
      server('server-2', '计算节点二'),
      {
        id: 'leaf-1',
        name: '接入交换机一',
        kind: 'leaf',
        device: 'switch',
        x: 100,
        y: 100,
        switch: {
          bufferPerPortKb: 256,
          tailDropMode: 'static',
          dynamicAlpha: 0.125,
          staticWatermarkKb: 65_536,
          sharedBufferKb: 2048,
          sharedBufferEnabled: true,
          switchingDelayUs: 2,
          ecn: defaultEcn(),
          pfc: defaultPfc(),
          dwrr: defaultDwrr(),
        },
      },
    ],
    links: [
      {
        id: 'link-1',
        name: '100GE0/0/1',
        source: 'server-1',
        target: 'leaf-1',
        rateGbps: 100,
        propagationUs: 1,
        enabled: true,
      },
      {
        id: 'link-2',
        name: '25GE0/0/2',
        source: 'server-2',
        target: 'leaf-1',
        rateGbps: 25,
        propagationUs: 1,
        enabled: true,
      },
    ],
    flows: [],
    settings: {
      durationUs: 10_000,
      sampleIntervalUs: 100,
      maxFrameBytes: 9000,
      retransmissionTimeoutUs: 1000,
      randomSeed: 1,
    },
  };
}

function makeResult(): SimulationResult {
  return {
    frames: [
      {
        timeUs: 1234,
        links: {
          'link-1': {
            utilizationGbps: 72.5,
            goodputGbps: 70,
            queueKb: 88,
            inputQueueKb: 12,
            ecnMarks: 9,
            drops: 2,
            pfcPauses: 3,
            pausedMask: 8,
          },
        },
        flows: {},
        total: {
          offeredGbps: 80,
          goodputGbps: 70,
          maxQueueKb: 88,
          ecnMarks: 9,
          drops: 2,
          pfcPauses: 3,
          activePauses: 1,
        },
      },
    ],
    events: [],
    traces: [],
    summary: {
      durationUs: 1234,
      offeredGbps: 80,
      goodputGbps: 70,
      peakQueueKb: 88,
      ecnMarks: 9,
      cnpCount: 4,
      drops: 2,
      retransmissions: 1,
      pfcPauses: 3,
      pfcBusyUs: 20,
      averageRttUs: 150,
      p95RttUs: 180,
      maxRttUs: 200,
      completedFlows: 0,
      totalFlows: 0,
      convergence: [],
      insights: [],
    },
  };
}

function snapshot(config: NetworkConfig): NetworkConfig {
  return JSON.parse(JSON.stringify(config)) as NetworkConfig;
}

describe('executeCommand 基础行为与不可变性', () => {
  it('提供帮助、教学兼容范围说明和 system-view 提示', () => {
    const config = makeConfig();
    const help = executeCommand(config, 'server-1', '?');
    expect(help.success).toBe(true);
    expect(help.output).toContain('教学子集');
    expect(help.output).toContain('并非完整华为命令实现');
    expect(help.output).toContain('dcqcn alpha');

    const systemView = executeCommand(config, 'server-1', 'help\nsystem-view');
    expect(systemView.success).toBe(true);
    expect(systemView.output).toContain('系统视图提示');
    expect(systemView.output).toContain('中文 CE 风格');
  });

  it('深拷贝后应用多行服务器和链路配置，绝不修改原 config', () => {
    const config = makeConfig();
    const before = snapshot(config);
    const executed = executeCommand(
      config,
      'server-1',
      [
        'sysname 新计算节点',
        'priority 4 pfc enable',
        'pfc xoff 512 xon 128',
        'dcqcn disable',
        'dcqcn alpha 0.35',
        'dcqcn min-rate 2 max-rate 80',
        'dcqcn recovery-interval 75',
        'mtu 9216',
        'roce priority 4',
        'interface 100GE0/0/1',
        'rate 40',
        'shutdown',
      ].join('\n'),
    );

    expect(executed.success).toBe(true);
    expect(config).toEqual(before);
    expect(executed.config).not.toBe(config);
    expect(executed.config.nodes).not.toBe(config.nodes);
    expect(executed.config.links).not.toBe(config.links);
    const node = executed.config.nodes.find((item) => item.id === 'server-1');
    expect(node?.device).toBe('server');
    if (node?.device !== 'server') throw new Error('测试节点类型错误');
    expect(node.name).toBe('新计算节点');
    expect(node.nic.pfc.enabled).toBe(true);
    expect(node.nic.pfc.priorities).toEqual([3, 4]);
    expect(node.nic.pfc.xoffKb).toBe(512);
    expect(node.nic.pfc.xonKb).toBe(128);
    expect(node.nic.dcqcn).toMatchObject({
      enabled: false,
      alpha: 0.35,
      minRateGbps: 2,
      maxRateGbps: 80,
      recoveryIntervalUs: 75,
    });
    expect(node.nic.mtuBytes).toBe(9216);
    expect(node.nic.rocePriority).toBe(4);
    expect(executed.config.links[0]).toMatchObject({ rateGbps: 40, enabled: false });
    expect(config.links[0]).toMatchObject({ rateGbps: 100, enabled: true });
  });

  it('一次多行输入中的后续 undo shutdown 使用同一接口上下文', () => {
    const config = makeConfig();
    const executed = executeCommand(
      config,
      'leaf-1',
      'interface 100GE 0/0/1\nrate 50.5\nshutdown\nundo shutdown',
    );
    expect(executed.success).toBe(true);
    expect(executed.output).toContain('接口视图');
    expect(executed.config.links[0]).toMatchObject({ rateGbps: 50.5, enabled: true });
    expect(config.links[0]).toMatchObject({ rateGbps: 100, enabled: true });
  });

  it('空输入与注释不修改数据，并给出帮助提示', () => {
    const config = makeConfig();
    const executed = executeCommand(config, 'server-1', '  \n# 注释\n');
    expect(executed.success).toBe(true);
    expect(executed.output).toContain('未输入命令');
    expect(executed.config).toEqual(config);
    expect(executed.config).not.toBe(config);
  });

  it('不存在的设备明确报错', () => {
    const config = makeConfig();
    const executed = executeCommand(config, 'missing', 'help');
    expect(executed.success).toBe(false);
    expect(executed.output).toContain('不存在设备“missing”');
    expect(executed.config).toEqual(config);
  });
});

describe('交换机配置与华为风格别名', () => {
  it('应用 PFC、ECN、DWRR 和 buffer 配置', () => {
    const config = makeConfig();
    const before = snapshot(config);
    const executed = executeCommand(
      config,
      'leaf-1',
      [
        'sysname Leaf-A',
        'priority 4 pfc enable',
        'priority 3 pfc disable',
        'pfc xoff 512 xon 128',
        'ecn disable',
        'ecn priority 4 low-limit 32 high-limit 128 probability 0.25',
        'dwrr priority 4 weight 80',
        'buffer shared 4096',
        'buffer port 512',
      ].join('\n'),
    );
    expect(executed.success).toBe(true);
    expect(config).toEqual(before);
    const node = executed.config.nodes.find((item) => item.id === 'leaf-1');
    if (node?.device !== 'switch') throw new Error('测试节点类型错误');
    expect(node.name).toBe('Leaf-A');
    expect(node.switch.pfc).toMatchObject({
      enabled: true,
      priorities: [4],
      xoffKb: 512,
      xonKb: 128,
    });
    expect(node.switch.ecn).toMatchObject({
      enabled: true,
      priorities: [3, 4],
      minKb: 32,
      maxKb: 128,
      maxProbability: 0.25,
    });
    expect(node.switch.dwrr.enabled).toBe(true);
    expect(node.switch.dwrr.weights[4]).toBe(80);
    expect(node.switch.sharedBufferKb).toBe(4096);
    expect(node.switch.bufferPerPortKb).toBe(512);
  });

  it('支持 dcb pfc/ecn/ets 的 enable、disable 和 undo 形式', () => {
    const config = makeConfig();
    const disabled = executeCommand(
      config,
      'leaf-1',
      'dcb pfc disable\ndcb ecn disable\ndcb ets disable',
    );
    expect(disabled.success).toBe(true);
    const disabledNode = disabled.config.nodes.find((item) => item.id === 'leaf-1');
    if (disabledNode?.device !== 'switch') throw new Error('测试节点类型错误');
    expect(disabledNode.switch.pfc.enabled).toBe(false);
    expect(disabledNode.switch.ecn.enabled).toBe(false);
    expect(disabledNode.switch.dwrr.enabled).toBe(false);

    const changed = executeCommand(
      disabled.config,
      'leaf-1',
      'dcb pfc enable\nundo dcb ecn enable\nundo dcb ets enable',
    );
    expect(changed.success).toBe(true);
    const changedNode = changed.config.nodes.find((item) => item.id === 'leaf-1');
    if (changedNode?.device !== 'switch') throw new Error('测试节点类型错误');
    expect(changedNode.switch.pfc.enabled).toBe(true);
    expect(changedNode.switch.ecn.enabled).toBe(false);
    expect(changedNode.switch.dwrr.enabled).toBe(false);

    const undonePfc = executeCommand(changed.config, 'leaf-1', 'undo dcb pfc enable');
    expect(undonePfc.success).toBe(true);
    const undoneNode = undonePfc.config.nodes.find((item) => item.id === 'leaf-1');
    if (undoneNode?.device !== 'switch') throw new Error('测试节点类型错误');
    expect(undoneNode.switch.pfc.enabled).toBe(false);

    const enabled = executeCommand(changed.config, 'leaf-1', 'dcb ecn enable\ndcb ets enable');
    expect(enabled.success).toBe(true);
    const enabledNode = enabled.config.nodes.find((item) => item.id === 'leaf-1');
    if (enabledNode?.device !== 'switch') throw new Error('测试节点类型错误');
    expect(enabledNode.switch.ecn.enabled).toBe(true);
    expect(enabledNode.switch.dwrr.enabled).toBe(true);
  });

  it('禁用最后一个 PFC 优先级时同步关闭 PFC', () => {
    const config = makeConfig();
    const executed = executeCommand(config, 'server-1', 'priority 3 pfc disable');
    expect(executed.success).toBe(true);
    const node = executed.config.nodes[0];
    if (node.device !== 'server') throw new Error('测试节点类型错误');
    expect(node.nic.pfc.priorities).toEqual([]);
    expect(node.nic.pfc.enabled).toBe(false);
  });
});

describe('参数错误、上下文和设备适用性', () => {
  it.each([
    ['priority 8 pfc enable', '0-7'],
    ['priority 3 pfc perhaps', '用法'],
    ['pfc xoff 100 xon 100', '必须小于'],
    ['pfc xoff nope xon 10', '十进制数字'],
    ['dcqcn alpha 1.1', '0-1'],
    ['dcqcn min-rate 101 max-rate 100', '不能大于'],
    ['dcqcn recovery-interval 0', '大于 0'],
    ['mtu 9000.5', '整数'],
    ['roce priority -1', '0-7'],
  ])('服务器非法输入 %s 会失败且不修改配置', (input, message) => {
    const config = makeConfig();
    const executed = executeCommand(config, 'server-1', input);
    expect(executed.success).toBe(false);
    expect(executed.output).toContain('错误');
    expect(executed.output).toContain(message);
    expect(executed.config).toEqual(config);
  });

  it.each([
    ['ecn priority 3 low-limit 128 high-limit 32', 'low-limit'],
    ['ecn priority 3 low-limit 1 high-limit 32 probability 2', '0-1'],
    ['dwrr priority 3 weight -1', '不能小于 0'],
    ['buffer shared -1', '不能小于 0'],
    ['buffer port 1.5', '整数'],
  ])('交换机非法输入 %s 会失败且不修改配置', (input, message) => {
    const config = makeConfig();
    const executed = executeCommand(config, 'leaf-1', input);
    expect(executed.success).toBe(false);
    expect(executed.output).toContain(message);
    expect(executed.config).toEqual(config);
  });

  it.each([
    ['server-1', 'ecn enable', '仅适用于交换机'],
    ['server-1', 'dwrr priority 3 weight 10', '仅适用于交换机'],
    ['server-1', 'buffer shared 100', '仅适用于交换机'],
    ['leaf-1', 'dcqcn enable', '仅适用于服务器'],
    ['leaf-1', 'mtu 9000', '仅适用于服务器'],
    ['leaf-1', 'roce priority 3', '仅适用于服务器'],
  ])('节点 %s 执行非适用命令 %s 会明确报错', (nodeId, input, message) => {
    const config = makeConfig();
    const executed = executeCommand(config, nodeId, input);
    expect(executed.success).toBe(false);
    expect(executed.output).toContain(message);
    expect(executed.config).toEqual(config);
  });

  it('链路命令没有接口上下文时给出教学提示', () => {
    const config = makeConfig();
    for (const input of ['rate 100', 'shutdown', 'undo shutdown']) {
      const executed = executeCommand(config, 'server-1', input);
      expect(executed.success).toBe(false);
      expect(executed.output).toContain('请先执行 interface');
      expect(executed.config).toEqual(config);
    }
  });

  it('拒绝不存在、属于其他设备或类型不支持的接口', () => {
    const config = makeConfig();
    const missing = executeCommand(config, 'server-1', 'interface 100GE0/0/9');
    expect(missing.success).toBe(false);
    expect(missing.output).toContain('不存在接口');

    const otherNode = executeCommand(config, 'server-1', 'interface 25GE0/0/2');
    expect(otherNode.success).toBe(false);
    expect(otherNode.output).toContain('display interface');

    const invalid = executeCommand(config, 'server-1', 'interface GE0/0/1');
    expect(invalid.success).toBe(false);
    expect(invalid.output).toContain('仅支持 100GE、25GE、40GE、200GE、400GE');
  });

  it('多行中保留已成功修改，汇总 success=false 并标出失败行', () => {
    const config = makeConfig();
    const before = snapshot(config);
    const executed = executeCommand(config, 'server-1', 'mtu 9216\nunknown-command\nroce priority 4');
    expect(executed.success).toBe(false);
    expect(executed.output).toContain('第 2 行错误');
    expect(executed.output).toContain('help');
    expect(config).toEqual(before);
    const node = executed.config.nodes[0];
    if (node.device !== 'server') throw new Error('测试节点类型错误');
    expect(node.nic.mtuBytes).toBe(9216);
    expect(node.nic.rocePriority).toBe(4);
  });
});

describe('中文 display 输出', () => {
  it('display current-configuration 和 display dcb 展示已应用配置', () => {
    const config = makeConfig();
    const changed = executeCommand(
      config,
      'leaf-1',
      'sysname Leaf-Display\necn priority 5 low-limit 16 high-limit 64 probability 0.5\ndwrr priority 5 weight 60',
    );
    expect(changed.success).toBe(true);
    const displayed = executeCommand(
      changed.config,
      'leaf-1',
      'display current-configuration\ndisplay dcb',
    );
    expect(displayed.success).toBe(true);
    expect(displayed.output).toContain('当前配置');
    expect(displayed.output).toContain('sysname Leaf-Display');
    expect(displayed.output).toContain('low/high-limit：16/64 KB');
    expect(displayed.output).toContain('P5=60');
    expect(displayed.output).toContain('接口信息');
  });

  it('display interface 支持全部、指定接口和中文表格', () => {
    const config = makeConfig();
    const all = executeCommand(config, 'leaf-1', 'display interface');
    expect(all.success).toBe(true);
    expect(all.output).toContain('100GE0/0/1');
    expect(all.output).toContain('25GE0/0/2');
    expect(all.output).toContain('速率(Gbps)');

    const one = executeCommand(config, 'leaf-1', 'display interface 100GE0/0/1');
    expect(one.success).toBe(true);
    expect(one.output).toContain('计算节点一');
    expect(one.output).not.toContain('25GE0/0/2');

    const missing = executeCommand(config, 'leaf-1', 'display interface 400GE9/9/9');
    expect(missing.success).toBe(false);
    expect(missing.output).toContain('不存在接口');
  });

  it('没有仿真结果时明确提示，而不伪造队列统计', () => {
    const config = makeConfig();
    const executed = executeCommand(config, 'server-1', 'display qos queue statistics');
    expect(executed.success).toBe(true);
    expect(executed.output).toContain('暂无仿真统计');
    expect(executed.output).toContain('请先运行仿真');
  });

  it('有 result 时显示最新帧统计，接口上下文可限定查询链路', () => {
    const config = makeConfig();
    const executed = executeCommand(
      config,
      'leaf-1',
      'interface 100GE0/0/1\ndisplay qos queue statistics',
      makeResult(),
    );
    expect(executed.success).toBe(true);
    expect(executed.output).toContain('采样时刻 1234 us');
    expect(executed.output).toContain('100GE0/0/1 | 72.5 | 70 | 88 | 12 | 9 | 2 | 3');
    expect(executed.output).not.toContain('25GE0/0/2 |');
    expect(executed.config).toEqual(config);
  });
});
