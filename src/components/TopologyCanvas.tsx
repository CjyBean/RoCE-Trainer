import { useMemo, useRef, useState } from 'react';
import {
  Cable,
  Database,
  Focus,
  Link2,
  Minus,
  MousePointer2,
  Network,
  Plus,
  Server,
  Trash2,
} from 'lucide-react';
import type { MetricFrame, NetworkConfig, NetworkNode, NodeKind, PacketTrace } from '../sim/types';
import { clamp } from '../utils/format';

interface TopologyCanvasProps {
  config: NetworkConfig;
  selectedId: string | null;
  currentFrame: MetricFrame | null;
  traces: PacketTrace[];
  timeUs: number;
  playing: boolean;
  linkMode: boolean;
  linkSource: string | null;
  onSelect: (id: string | null) => void;
  onNodeMove: (id: string, x: number, y: number) => void;
  onAddDevice: (kind: NodeKind, x: number, y: number) => void;
  onToggleLinkMode: () => void;
  onLinkNode: (id: string) => void;
  onDelete: () => void;
}

const WIDTH = 1000;
const HEIGHT = 540;

function nodeTypeName(node: NetworkNode) {
  if (node.kind === 'compute') return 'COMPUTE · 100G';
  if (node.kind === 'storage') return 'STORAGE · NFS/RDMA';
  return node.kind === 'leaf' ? 'LEAF · DCB' : 'SPINE · DCB';
}

function NodeIcon({ node }: { node: NetworkNode }) {
  const props = { x: -43, y: -12, size: 22, strokeWidth: 1.7 };
  if (node.kind === 'compute') return <Server {...props} />;
  if (node.kind === 'storage') return <Database {...props} />;
  return <Network {...props} />;
}

export function TopologyCanvas({
  config,
  selectedId,
  currentFrame,
  traces,
  timeUs,
  playing,
  linkMode,
  linkSource,
  onSelect,
  onNodeMove,
  onAddDevice,
  onToggleLinkMode,
  onLinkNode,
  onDelete,
}: TopologyCanvasProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [zoom, setZoom] = useState(1);
  const [dragging, setDragging] = useState<{ id: string; dx: number; dy: number } | null>(null);
  const nodeMap = useMemo(() => new Map(config.nodes.map((node) => [node.id, node])), [config.nodes]);

  const toCanvas = (event: { clientX: number; clientY: number }) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const point = svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const local = point.matrixTransform(svg.getScreenCTM()?.inverse());
    return {
      x: (local.x - WIDTH / 2) / zoom + WIDTH / 2,
      y: (local.y - HEIGHT / 2) / zoom + HEIGHT / 2,
    };
  };

  const visibleTraces = useMemo(() => {
    const windowUs = playing ? 500 : 80;
    return traces.filter((trace) => timeUs >= trace.timeUs && timeUs - trace.timeUs <= windowUs).slice(-140);
  }, [traces, timeUs, playing]);

  const tracePosition = (trace: PacketTrace) => {
    const from = nodeMap.get(trace.fromNodeId);
    const to = nodeMap.get(trace.toNodeId);
    if (!from || !to) return null;
    const displayDuration = Math.max(trace.endUs - trace.timeUs, playing ? 500 : 80);
    const progress = clamp((timeUs - trace.timeUs) / displayDuration, 0, 1);
    return {
      x: from.x + (to.x - from.x) * progress,
      y: from.y + (to.y - from.y) * progress,
    };
  };

  return (
    <section className={`topology-canvas ${linkMode ? 'is-linking' : ''}`}>
      <div className="canvas-toolbar floating-panel">
        <button className={!linkMode ? 'active' : ''} title="选择与拖拽" onClick={() => linkMode && onToggleLinkMode()}>
          <MousePointer2 size={16} />
        </button>
        <button className={linkMode ? 'active' : ''} title="连接设备：依次点击两个节点" onClick={onToggleLinkMode}>
          <Link2 size={16} />
        </button>
        <span className="toolbar-separator" />
        <button title="删除所选" disabled={!selectedId} onClick={onDelete}><Trash2 size={16} /></button>
      </div>

      <div className="canvas-mode-label">
        {linkMode ? (
          <><Cable size={14} />{linkSource ? `已选 ${nodeMap.get(linkSource)?.name}，请点击对端设备` : '连线模式：点击第一个设备'}</>
        ) : (
          <><span className="status-dot" />{currentFrame ? `T = ${(timeUs / 1000).toFixed(2)} ms` : '拓扑编辑模式'}</>
        )}
      </div>

      <svg
        ref={svgRef}
        className="topology-svg"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        onPointerDown={(event) => {
          if (!(event.target as Element).closest('.device-node')) onSelect(null);
        }}
        onPointerMove={(event) => {
          if (!dragging) return;
          const point = toCanvas(event);
          onNodeMove(dragging.id, clamp(point.x + dragging.dx, 60, WIDTH - 60), clamp(point.y + dragging.dy, 50, HEIGHT - 50));
        }}
        onPointerUp={() => setDragging(null)}
        onPointerLeave={() => setDragging(null)}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          const kind = event.dataTransfer.getData('application/x-roce-node') as NodeKind;
          if (!kind) return;
          const point = toCanvas(event);
          onAddDevice(kind, point.x, point.y);
        }}
      >
        <defs>
          <filter id="packetGlow" x="-200%" y="-200%" width="400%" height="400%">
            <feGaussianBlur stdDeviation="1.5" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>
        <rect width={WIDTH} height={HEIGHT} fill="#fafafa" />
        <g transform={`translate(${WIDTH / 2} ${HEIGHT / 2}) scale(${zoom}) translate(${-WIDTH / 2} ${-HEIGHT / 2})`}>
          {config.links.map((link) => {
            const source = nodeMap.get(link.source);
            const target = nodeMap.get(link.target);
            if (!source || !target) return null;
            const metric = currentFrame?.links[link.id];
            const selected = selectedId === link.id;
            const congested = (metric?.queueKb ?? 0) > 32;
            const paused = Boolean(metric?.pausedMask);
            const stroke = !link.enabled ? '#cbd5e1' : paused ? '#e11d48' : congested ? '#d97706' : selected ? '#2563eb' : '#cbd5e1';
            return (
              <g key={link.id} className={`network-link ${selected ? 'selected' : ''} ${!link.enabled ? 'disabled' : ''}`}>
                <line x1={source.x} y1={source.y} x2={target.x} y2={target.y} stroke={stroke} strokeWidth={selected ? 2 : 1.4} strokeDasharray={link.enabled ? undefined : '6 6'} />
                <line
                  className="link-hitbox" x1={source.x} y1={source.y} x2={target.x} y2={target.y}
                  stroke="transparent" strokeWidth={16}
                  onPointerDown={(event) => { event.stopPropagation(); onSelect(link.id); }}
                />
                {(selected || congested || paused) && (
                  <g transform={`translate(${(source.x + target.x) / 2} ${(source.y + target.y) / 2 - 9})`} pointerEvents="none">
                    <rect x={-34} y={-10} width={68} height={20} rx={5} fill="#fff" stroke={stroke} strokeWidth={0.8} />
                    <text textAnchor="middle" dominantBaseline="middle" fill={stroke} fontSize={9} fontWeight={600}>
                      {paused ? 'PFC PAUSE' : congested ? `${metric?.queueKb.toFixed(0)} KB` : `${link.rateGbps} GE`}
                    </text>
                  </g>
                )}
              </g>
            );
          })}

          {visibleTraces.map((trace) => {
            const position = tracePosition(trace);
            if (!position) return null;
            const color = trace.kind === 'pfc' ? '#e11d48' : trace.kind === 'cnp' ? '#7c3aed' : trace.marked ? '#d97706' : trace.kind === 'control' ? '#0891b2' : '#2563eb';
            return (
              <circle
                key={`${trace.id}-${trace.timeUs}`} cx={position.x} cy={position.y}
                r={trace.kind === 'pfc' || trace.kind === 'cnp' ? 4 : 3.2}
                fill={color} filter="url(#packetGlow)" pointerEvents="none"
              />
            );
          })}

          {config.nodes.map((node) => {
            const selected = selectedId === node.id;
            const isLinkSource = linkSource === node.id;
            return (
              <g
                key={node.id}
                className={`device-node ${node.kind} ${selected ? 'selected' : ''} ${isLinkSource ? 'link-source' : ''}`}
                transform={`translate(${node.x} ${node.y})`}
                role="button"
                tabIndex={0}
                aria-label={`${node.name}，${nodeTypeName(node)}`}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    event.stopPropagation();
                    if (linkMode) onLinkNode(node.id);
                    else onSelect(node.id);
                  }
                }}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  if (linkMode) {
                    onLinkNode(node.id);
                    return;
                  }
                  onSelect(node.id);
                  const point = toCanvas(event);
                  setDragging({ id: node.id, dx: node.x - point.x, dy: node.y - point.y });
                  (event.currentTarget as SVGGElement).setPointerCapture(event.pointerId);
                }}
              >
                <title>{node.name} · {nodeTypeName(node)}</title>
                <rect x={-61} y={-30} width={122} height={60} rx={9} className="node-body" />
                <rect x={-61} y={-30} width={4} height={60} rx={2} className="node-accent" />
                <g className="node-icon"><NodeIcon node={node} /></g>
                <text x={-13} y={-4} className="node-name">{node.name}</text>
                <text x={-13} y={13} className="node-type">{nodeTypeName(node)}</text>
              </g>
            );
          })}
        </g>
      </svg>

      <div className="canvas-zoom floating-panel">
        <button title="缩小" onClick={() => setZoom((value) => clamp(value - 0.15, 0.55, 1.8))}><Minus size={15} /></button>
        <span>{Math.round(zoom * 100)}%</span>
        <button title="放大" onClick={() => setZoom((value) => clamp(value + 0.15, 0.55, 1.8))}><Plus size={15} /></button>
        <button title="适应画布" onClick={() => setZoom(1)}><Focus size={15} /></button>
      </div>

      <div className="topology-legend">
        <span><i className="legend-packet data" />RoCE 数据</span>
        <span><i className="legend-packet marked" />ECN 标记</span>
        <span><i className="legend-packet cnp" />CNP</span>
        <span><i className="legend-line pfc" />PFC 暂停</span>
      </div>
    </section>
  );
}
