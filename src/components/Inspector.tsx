import { useState } from 'react';
import { Cable, Network, Server, Settings2, SlidersHorizontal, TerminalSquare } from 'lucide-react';
import type {
  DcqcnConfig,
  DwrrConfig,
  EcnConfig,
  NetworkConfig,
  NetworkLink,
  NetworkNode,
  PfcConfig,
  Priority,
  ServerNode,
  SimulationResult,
  SwitchNode,
} from '../sim/types';
import type { LabDefinition } from '../data/labs';
import { ConfigSection, FieldGrid, NumberField, SelectField, TextField, ToggleField } from './Controls';
import { LabGuide } from './LabGuide';
import { TrafficEditor } from './TrafficEditor';
import { CliPanel } from './CliPanel';

interface InspectorProps {
  config: NetworkConfig;
  selectedId: string | null;
  activeLab: LabDefinition;
  variantId: string;
  result: SimulationResult | null;
  onChange: (config: NetworkConfig) => void;
  onVariant: (id: string) => void;
}

type InspectorTab = 'config' | 'traffic' | 'cli';

function PriorityPicker({ values, onChange }: { values: Priority[]; onChange: (values: Priority[]) => void }) {
  return (
    <div className="priority-picker"><span>作用优先级</span><div>{[0, 1, 2, 3, 4, 5, 6, 7].map((value) => {
      const priority = value as Priority;
      const active = values.includes(priority);
      return <button key={value} className={active ? 'active' : ''} onClick={() => onChange(active ? values.filter((item) => item !== priority) : [...values, priority].sort())}>{value}</button>;
    })}</div></div>
  );
}

function PfcFields({ value, onChange }: { value: PfcConfig; onChange: (value: PfcConfig) => void }) {
  return <>
    <ToggleField label="启用 PFC" checked={value.enabled} onChange={(enabled) => onChange({ ...value, enabled })} description="按优先级逐跳反压" />
    <PriorityPicker values={value.priorities} onChange={(priorities) => onChange({ ...value, priorities })} />
    <FieldGrid>
      <NumberField label="XOFF 门限" value={value.xoffKb} unit="KB" min={1} onChange={(xoffKb) => onChange({ ...value, xoffKb })} />
      <NumberField label="XON 门限" value={value.xonKb} unit="KB" min={0} onChange={(xonKb) => onChange({ ...value, xonKb })} />
      <NumberField label="Headroom" value={value.headroomKb} unit="KB" min={0} onChange={(headroomKb) => onChange({ ...value, headroomKb })} />
    </FieldGrid>
    {value.xonKb >= value.xoffKb && <p className="field-warning">XON 应低于 XOFF，否则队列可能持续处于暂停状态。</p>}
  </>;
}

function EcnFields({ value, onChange }: { value: EcnConfig; onChange: (value: EcnConfig) => void }) {
  return <>
    <ToggleField label="启用 ECN" checked={value.enabled} onChange={(enabled) => onChange({ ...value, enabled })} description="在丢包前发出拥塞信号" />
    <PriorityPicker values={value.priorities} onChange={(priorities) => onChange({ ...value, priorities })} />
    <FieldGrid>
      <NumberField label="最小门限" value={value.minKb} unit="KB" min={0} onChange={(minKb) => onChange({ ...value, minKb })} />
      <NumberField label="最大门限" value={value.maxKb} unit="KB" min={1} onChange={(maxKb) => onChange({ ...value, maxKb })} />
      <NumberField label="最大标记概率" value={value.maxProbability} min={0.01} max={1} step={0.05} onChange={(maxProbability) => onChange({ ...value, maxProbability })} />
    </FieldGrid>
    {value.minKb >= value.maxKb && <p className="field-warning">最小门限应低于最大门限。</p>}
  </>;
}

function DwrrFields({ value, onChange }: { value: DwrrConfig; onChange: (value: DwrrConfig) => void }) {
  return <>
    <ToggleField label="启用 DWRR" checked={value.enabled} onChange={(enabled) => onChange({ ...value, enabled })} />
    <ToggleField label="控制流严格优先" checked={value.controlStrictPriority} onChange={(controlStrictPriority) => onChange({ ...value, controlStrictPriority })} description="P7 CNP、P6 ACK 优先于数据" />
    <div className="weights-grid">{[0, 1, 2, 3, 4, 5].map((priority) => (
      <NumberField key={priority} label={`P${priority} 权重`} value={value.weights[priority as Priority]} min={0} max={100} onChange={(weight) => onChange({ ...value, weights: { ...value.weights, [priority]: weight } })} />
    ))}</div>
  </>;
}

function DcqcnFields({ value, onChange }: { value: DcqcnConfig; onChange: (value: DcqcnConfig) => void }) {
  return <>
    <ToggleField label="启用 DCQCN" checked={value.enabled} onChange={(enabled) => onChange({ ...value, enabled })} description="CNP 驱动的端侧速率控制" />
    <FieldGrid>
      <NumberField label="初始速率" value={value.initialRateGbps} unit="Gbps" min={0.1} step={0.1} onChange={(initialRateGbps) => onChange({ ...value, initialRateGbps })} />
      <NumberField label="最小速率" value={value.minRateGbps} unit="Gbps" min={0.1} step={0.1} onChange={(minRateGbps) => onChange({ ...value, minRateGbps })} />
      <NumberField label="最大速率" value={value.maxRateGbps} unit="Gbps" min={1} onChange={(maxRateGbps) => onChange({ ...value, maxRateGbps })} />
      <NumberField label="Alpha" value={value.alpha} min={0.001} max={1} step={0.01} onChange={(alpha) => onChange({ ...value, alpha })} />
      <NumberField label="Alpha 增益" value={value.alphaGain} min={0.01} max={1} step={0.01} onChange={(alphaGain) => onChange({ ...value, alphaGain })} />
      <NumberField label="恢复步长" value={value.rateIncreaseGbps} unit="Gbps" min={0.1} step={0.1} onChange={(rateIncreaseGbps) => onChange({ ...value, rateIncreaseGbps })} />
      <NumberField label="恢复周期" value={value.recoveryIntervalUs} unit="µs" min={1} onChange={(recoveryIntervalUs) => onChange({ ...value, recoveryIntervalUs })} />
      <NumberField label="CNP 最小间隔" value={value.cnpIntervalUs} unit="µs" min={1} onChange={(cnpIntervalUs) => onChange({ ...value, cnpIntervalUs })} />
    </FieldGrid>
  </>;
}

function ServerForm({ node, update }: { node: ServerNode; update: (recipe: (node: ServerNode) => void) => void }) {
  return <>
    <ConfigSection title="服务器与网卡" badge="RoCEv2" defaultOpen>
      <TextField label="设备名称" value={node.name} onChange={(name) => update((item) => { item.name = name; })} />
      <FieldGrid>
        <NumberField label="NIC 速率" value={node.nic.rateGbps} unit="Gbps" min={1} onChange={(rateGbps) => update((item) => { item.nic.rateGbps = rateGbps; })} />
        <NumberField label="MTU" value={node.nic.mtuBytes} unit="Byte" min={1500} max={9216} step={1} onChange={(mtuBytes) => update((item) => { item.nic.mtuBytes = mtuBytes; })} />
        <NumberField label="主机服务上限" value={node.serviceLimitGbps} unit="Gbps" min={1} onChange={(serviceLimitGbps) => update((item) => { item.serviceLimitGbps = serviceLimitGbps; })} />
        <SelectField label="RoCE 优先级" value={node.nic.rocePriority} onChange={(value) => update((item) => { item.nic.rocePriority = Number(value) as Priority; })}>
          {[0, 1, 2, 3, 4, 5].map((priority) => <option key={priority} value={priority}>优先级 {priority}</option>)}
        </SelectField>
      </FieldGrid>
    </ConfigSection>
    <ConfigSection title="DCQCN 拥塞控制" badge={node.nic.dcqcn.enabled ? 'ON' : 'OFF'}>
      <DcqcnFields value={node.nic.dcqcn} onChange={(dcqcn) => update((item) => { item.nic.dcqcn = dcqcn; })} />
    </ConfigSection>
    <ConfigSection title="PFC 优先级流控" badge={node.nic.pfc.enabled ? 'ON' : 'OFF'}>
      <PfcFields value={node.nic.pfc} onChange={(pfc) => update((item) => { item.nic.pfc = pfc; })} />
    </ConfigSection>
    <ConfigSection title="NIC DWRR 调度" badge="8 QUEUES">
      <DwrrFields value={node.nic.dwrr} onChange={(dwrr) => update((item) => { item.nic.dwrr = dwrr; })} />
    </ConfigSection>
  </>;
}

function SwitchForm({ node, update }: { node: SwitchNode; update: (recipe: (node: SwitchNode) => void) => void }) {
  return <>
    <ConfigSection title="交换机与缓冲" badge={node.kind.toUpperCase()} defaultOpen>
      <TextField label="设备名称" value={node.name} onChange={(name) => update((item) => { item.name = name; })} />
      <FieldGrid>
        <NumberField label="端口保留缓冲" value={node.switch.bufferPerPortKb} unit="KB" min={1} onChange={(bufferPerPortKb) => update((item) => { item.switch.bufferPerPortKb = bufferPerPortKb; })} />
        <NumberField label="共享缓冲池" value={node.switch.sharedBufferKb} unit="KB" min={0} onChange={(sharedBufferKb) => update((item) => { item.switch.sharedBufferKb = sharedBufferKb; })} />
        <NumberField label="交换时延" value={node.switch.switchingDelayUs} unit="µs" min={0.1} step={0.1} onChange={(switchingDelayUs) => update((item) => { item.switch.switchingDelayUs = switchingDelayUs; })} />
      </FieldGrid>
      <ToggleField label="启用共享缓冲池" checked={node.switch.sharedBufferEnabled} onChange={(sharedBufferEnabled) => update((item) => { item.switch.sharedBufferEnabled = sharedBufferEnabled; })} />
      <div className="config-divider">尾丢水线</div>
      <SelectField label="尾丢模式" value={node.switch.tailDropMode} onChange={(value) => update((item) => { item.switch.tailDropMode = value as 'dynamic' | 'static'; })}>
        <option value="dynamic">shared dynamic</option>
        <option value="static">static</option>
      </SelectField>
      {node.switch.tailDropMode === 'static' ? (
        <NumberField label="static 水线" value={node.switch.staticWatermarkKb} unit="KB" min={1} onChange={(staticWatermarkKb) => update((item) => { item.switch.staticWatermarkKb = staticWatermarkKb; })} />
      ) : (
        <NumberField label="dynamic Alpha" value={node.switch.dynamicAlpha} min={0} max={16} step={0.01} onChange={(dynamicAlpha) => update((item) => { item.switch.dynamicAlpha = dynamicAlpha; })} />
      )}
    </ConfigSection>
    <ConfigSection title="ECN / WRED 标记" badge={node.switch.ecn.enabled ? 'ON' : 'OFF'}>
      <EcnFields value={node.switch.ecn} onChange={(ecn) => update((item) => { item.switch.ecn = ecn; })} />
    </ConfigSection>
    <ConfigSection title="PFC 优先级流控" badge={node.switch.pfc.enabled ? 'ON' : 'OFF'}>
      <PfcFields value={node.switch.pfc} onChange={(pfc) => update((item) => { item.switch.pfc = pfc; })} />
    </ConfigSection>
    <ConfigSection title="DWRR 队列调度" badge="8 QUEUES">
      <DwrrFields value={node.switch.dwrr} onChange={(dwrr) => update((item) => { item.switch.dwrr = dwrr; })} />
    </ConfigSection>
  </>;
}

function LinkForm({ link, config, update }: { link: NetworkLink; config: NetworkConfig; update: (recipe: (link: NetworkLink) => void) => void }) {
  const source = config.nodes.find((node) => node.id === link.source);
  const target = config.nodes.find((node) => node.id === link.target);
  return <ConfigSection title="链路属性" badge="FULL DUPLEX" defaultOpen>
    <div className="link-endpoints"><span>{source?.name}</span><Cable size={15} /><span>{target?.name}</span></div>
    <ToggleField label="启用链路" checked={link.enabled} onChange={(enabled) => update((item) => { item.enabled = enabled; })} />
    <FieldGrid>
      <SelectField label="链路速率" value={link.rateGbps} onChange={(value) => update((item) => { item.rateGbps = Number(value); })}>
        {[10, 25, 40, 50, 100, 200, 400].map((rate) => <option key={rate} value={rate}>{rate} GE</option>)}
      </SelectField>
      <NumberField label="传播时延" value={link.propagationUs} unit="µs" min={0.01} step={0.1} onChange={(propagationUs) => update((item) => { item.propagationUs = propagationUs; })} />
    </FieldGrid>
    <p className="form-footnote">链路为全双工；关闭后可模拟上行故障，并重新计算收敛比和 ECMP 路径。</p>
  </ConfigSection>;
}

export function Inspector({ config, selectedId, activeLab, variantId, result, onChange, onVariant }: InspectorProps) {
  const [tab, setTab] = useState<InspectorTab>('config');
  const node = config.nodes.find((item) => item.id === selectedId);
  const link = config.links.find((item) => item.id === selectedId);
  const cliNode = node ?? (link ? config.nodes.find((item) => item.id === link.source) : config.nodes.find((item) => item.device === 'switch'));

  const commit = (recipe: (next: NetworkConfig) => void) => {
    const next = structuredClone(config);
    recipe(next);
    onChange(next);
  };

  return (
    <aside className="inspector-panel">
      <div className="inspector-tabs">
        <button className={tab === 'config' ? 'active' : ''} onClick={() => setTab('config')}><SlidersHorizontal size={14} />属性</button>
        <button className={tab === 'traffic' ? 'active' : ''} onClick={() => setTab('traffic')}><Settings2 size={14} />业务</button>
        <button className={tab === 'cli' ? 'active' : ''} onClick={() => setTab('cli')}><TerminalSquare size={14} />CLI</button>
      </div>
      <div className="inspector-context">
        {node ? <>{node.device === 'server' ? <Server size={15} /> : <Network size={15} />}<span>{node.name}</span><i>{node.id}</i></> : link ? <><Cable size={15} /><span>{link.id}</span><i>{link.rateGbps} GE</i></> : <><SlidersHorizontal size={15} /><span>实验配置</span><i>未选择设备</i></>}
      </div>
      <div className="inspector-scroll">
        {tab === 'traffic' ? <TrafficEditor config={config} onChange={onChange} /> : tab === 'cli' ? (
          cliNode ? <CliPanel config={config} node={cliNode} result={result} onChange={onChange} /> : <div className="empty-selection">请先添加一台设备。</div>
        ) : node ? (
          node.device === 'server'
            ? <ServerForm node={node} update={(recipe) => commit((next) => recipe(next.nodes.find((item) => item.id === node.id) as ServerNode))} />
            : <SwitchForm node={node} update={(recipe) => commit((next) => recipe(next.nodes.find((item) => item.id === node.id) as SwitchNode))} />
        ) : link ? (
          <LinkForm link={link} config={config} update={(recipe) => commit((next) => recipe(next.links.find((item) => item.id === link.id)!))} />
        ) : <>
          <LabGuide lab={activeLab} variantId={variantId} onVariant={onVariant} />
          <ConfigSection title="仿真全局参数" badge={`${config.settings.durationUs / 1000} ms`}>
            <FieldGrid>
              <NumberField label="仿真时长" value={config.settings.durationUs / 1000} unit="ms" min={1} max={1000} onChange={(value) => commit((next) => { next.settings.durationUs = value * 1000; })} />
              <NumberField label="采样间隔" value={config.settings.sampleIntervalUs} unit="µs" min={1} onChange={(sampleIntervalUs) => commit((next) => { next.settings.sampleIntervalUs = sampleIntervalUs; })} />
              <NumberField label="随机种子" value={config.settings.randomSeed} min={1} onChange={(randomSeed) => commit((next) => { next.settings.randomSeed = randomSeed; })} />
              <NumberField label="重传超时" value={config.settings.retransmissionTimeoutUs} unit="µs" min={1} onChange={(retransmissionTimeoutUs) => commit((next) => { next.settings.retransmissionTimeoutUs = retransmissionTimeoutUs; })} />
            </FieldGrid>
          </ConfigSection>
        </>}
      </div>
    </aside>
  );
}
