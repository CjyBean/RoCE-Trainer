import type { NodeKind } from '../sim/types';
import type { LabDefinition } from '../data/labs';

interface LabSidebarProps {
  labs: LabDefinition[];
  activeLab: LabDefinition;
  onSelectLab: (id: string) => void;
  onAddDevice: (kind: NodeKind) => void;
}

const devices: { kind: NodeKind; name: string }[] = [
  { kind: 'compute', name: '计算服务器' },
  { kind: 'storage', name: '存储服务器' },
  { kind: 'leaf', name: 'Leaf 交换机' },
  { kind: 'spine', name: 'Spine 交换机' },
];

export function LabSidebar({ labs, activeLab, onSelectLab, onAddDevice }: LabSidebarProps) {
  return (
    <aside className="lab-sidebar">
      <div className="sidebar-heading">实验场景</div>
      <nav className="lab-list">
        {labs.map((lab) => (
          <button
            key={lab.id}
            className={`lab-nav-item ${activeLab.id === lab.id ? 'active' : ''}`}
            onClick={() => onSelectLab(lab.id)}
          >
            <span className="lab-index">{lab.index}</span>
            <span className="lab-nav-copy">
              <strong>{lab.shortTitle}</strong>
              <small>{lab.level}</small>
            </span>
          </button>
        ))}
      </nav>
      <div className="sidebar-heading device-library-title">拓扑设备</div>
      <div className="device-palette">
        {devices.map(({ kind, name }) => (
          <div key={kind} draggable onDragStart={(event) => { event.dataTransfer.setData('application/x-roce-node', kind); }}>
            <button onClick={() => onAddDevice(kind)}>{name}</button>
          </div>
        ))}
      </div>
      <div className="sidebar-model-note">教学级离散事件仿真 · 非硬件实测</div>
    </aside>
  );
}
