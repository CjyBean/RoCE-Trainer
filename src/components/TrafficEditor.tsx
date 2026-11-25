import { useEffect, useState } from 'react';
import { ArrowRight, Plus, Trash2 } from 'lucide-react';
import type { NetworkConfig, Priority, TrafficFlow, TrafficTemplate } from '../sim/types';
import { TRAFFIC_TEMPLATE_NAMES } from '../data/labs';
import { FieldGrid, NumberField, SelectField, ToggleField } from './Controls';

interface TrafficEditorProps {
  config: NetworkConfig;
  onChange: (config: NetworkConfig) => void;
}

export function TrafficEditor({ config, onChange }: TrafficEditorProps) {
  const [selectedFlowId, setSelectedFlowId] = useState(config.flows[0]?.id ?? '');
  useEffect(() => {
    if (!config.flows.some((flow) => flow.id === selectedFlowId)) setSelectedFlowId(config.flows[0]?.id ?? '');
  }, [config.flows, selectedFlowId]);
  const selected = config.flows.find((flow) => flow.id === selectedFlowId);
  const servers = config.nodes.filter((node) => node.device === 'server');

  const update = (id: string, patch: Partial<TrafficFlow>) => {
    onChange({ ...config, flows: config.flows.map((flow) => flow.id === id ? { ...flow, ...patch } : flow) });
  };

  const addFlow = () => {
    const id = `flow-custom-${Date.now()}`;
    const flow: TrafficFlow = {
      id, name: `NFS 业务 ${config.flows.length + 1}`,
      source: servers.find((node) => node.kind === 'compute')?.id ?? servers[0]?.id ?? '',
      target: servers.find((node) => node.kind === 'storage')?.id ?? servers[1]?.id ?? '',
      template: 'read-sequential', enabled: true, fileSizeMb: 16, requestSizeKb: 1024, queueDepth: 32,
      startTimeUs: 1000, burstIntervalUs: 5000, burstDurationUs: 500, backgroundRateGbps: 20, priority: 3,
    };
    onChange({ ...config, flows: [...config.flows, flow] });
    setSelectedFlowId(id);
  };

  return (
    <div className="traffic-editor">
      <div className="traffic-list-header"><span>业务流 · {config.flows.length}</span><button onClick={addFlow} disabled={servers.length < 2}><Plus size={13} />新建</button></div>
      <div className="traffic-list">
        {config.flows.map((flow) => (
          <button key={flow.id} className={`traffic-list-item ${selectedFlowId === flow.id ? 'active' : ''} ${!flow.enabled ? 'disabled' : ''}`} onClick={() => setSelectedFlowId(flow.id)}>
            <span className={`priority-tag p${flow.priority}`}>P{flow.priority}</span>
            <span><strong>{flow.name}</strong><small>{flow.source} <ArrowRight size={9} /> {flow.target}</small></span>
            <i className={flow.enabled ? 'flow-enabled' : ''} />
          </button>
        ))}
      </div>
      {selected ? (
        <div className="traffic-form">
          <div className="selected-form-title"><span>{selected.name}</span><button title="删除业务流" onClick={() => onChange({ ...config, flows: config.flows.filter((flow) => flow.id !== selected.id) })}><Trash2 size={14} /></button></div>
          <ToggleField label="启用此业务" checked={selected.enabled} onChange={(enabled) => update(selected.id, { enabled })} />
          <SelectField label="固定业务模板" value={selected.template} onChange={(value) => update(selected.id, { template: value as TrafficTemplate })}>
            {Object.entries(TRAFFIC_TEMPLATE_NAMES).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
          </SelectField>
          <SelectField label="源端" value={selected.source} onChange={(source) => update(selected.id, { source })}>
            {servers.map((node) => <option value={node.id} key={node.id}>{node.name}</option>)}
          </SelectField>
          <SelectField label="目的端" value={selected.target} onChange={(target) => update(selected.id, { target })}>
            {servers.map((node) => <option value={node.id} key={node.id}>{node.name}</option>)}
          </SelectField>
          <FieldGrid>
            <NumberField label="文件大小" value={selected.fileSizeMb} unit="MB" min={1} onChange={(fileSizeMb) => update(selected.id, { fileSizeMb })} />
            <NumberField label="NFS 请求" value={selected.requestSizeKb} unit="KB" min={4} step={4} onChange={(requestSizeKb) => update(selected.id, { requestSizeKb })} />
            <NumberField label="队列深度" value={selected.queueDepth} min={1} max={1024} onChange={(queueDepth) => update(selected.id, { queueDepth })} />
            <NumberField label="开始时间" value={selected.startTimeUs} unit="µs" min={0} onChange={(startTimeUs) => update(selected.id, { startTimeUs })} />
            <NumberField label="突发周期" value={selected.burstIntervalUs} unit="µs" min={1} onChange={(burstIntervalUs) => update(selected.id, { burstIntervalUs })} />
            <NumberField label="突发持续" value={selected.burstDurationUs} unit="µs" min={1} onChange={(burstDurationUs) => update(selected.id, { burstDurationUs })} />
            <NumberField label="背景速率" value={selected.backgroundRateGbps} unit="Gbps" min={0.1} step={0.1} onChange={(backgroundRateGbps) => update(selected.id, { backgroundRateGbps })} />
            <SelectField label="业务优先级" value={selected.priority} onChange={(value) => update(selected.id, { priority: Number(value) as Priority })}>
              {[0, 1, 2, 3, 4, 5].map((priority) => <option value={priority} key={priority}>优先级 {priority}{priority === 3 ? '（RoCE）' : priority === 0 ? '（背景）' : ''}</option>)}
            </SelectField>
          </FieldGrid>
          <p className="form-footnote">读写模板决定数据方向；微突发模板按周期同步发送，背景模板按固定速率持续发送。</p>
        </div>
      ) : <div className="empty-selection">暂无业务流，请新建。</div>}
    </div>
  );
}
