import { useMemo, useState } from 'react';
import { Activity, AlertTriangle, ArrowDownToLine, Gauge, Layers3, RadioTower, Timer } from 'lucide-react';
import type { MetricFrame, SimulationResult } from '../sim/types';
import { EVENT_NAMES, formatGbps, formatNumber, formatTime } from '../utils/format';
import { MetricChart, type ChartSeries } from './MetricChart';

interface MetricsPanelProps {
  result: SimulationResult | null;
  currentFrame: MetricFrame | null;
  timeUs: number;
  selectedId: string | null;
  onSeek: (timeUs: number) => void;
  onExport: () => void;
  exportDisabled?: boolean;
}

type ChartMode = 'throughput' | 'queue' | 'latency';
const colors = ['#2563eb', '#0d9488', '#7c3aed', '#d97706', '#e11d48', '#0891b2', '#65a30d', '#ea580c'];

export function MetricsPanel({ result, currentFrame, timeUs, selectedId, onSeek, onExport, exportDisabled }: MetricsPanelProps) {
  const [mode, setMode] = useState<ChartMode>('throughput');
  const [eventFilter, setEventFilter] = useState('all');
  const frames = result?.frames ?? [];
  const selectedLink = selectedId && currentFrame?.links[selectedId] ? selectedId : null;

  const chart = useMemo((): { series: ChartSeries[]; unit: string } => {
    if (mode === 'queue') {
      if (selectedLink) return { unit: 'KB', series: [{ id: 'queue', label: '所选链路队列', color: '#f59e0b', values: frames.map((f) => f.links[selectedLink]?.queueKb ?? 0) }] };
      return { unit: 'KB', series: [{ id: 'queue', label: '全网最大队列', color: '#f59e0b', values: frames.map((f) => f.total.maxQueueKb) }] };
    }
    if (mode === 'latency') {
      const flowIds = Object.keys(frames[0]?.flows ?? {}).slice(0, 8);
      return {
        unit: 'ms',
        series: flowIds.map((id, index) => ({ id, label: id, color: colors[index], values: frames.map((f) => (f.flows[id]?.rttUs ?? 0) / 1000) })),
      };
    }
    if (selectedLink) {
      return {
        unit: 'Gbps',
        series: [
          { id: 'util', label: '链路发送速率', color: '#6f9cff', values: frames.map((f) => f.links[selectedLink]?.utilizationGbps ?? 0) },
          { id: 'goodput', label: '业务 Goodput', color: '#2dd4bf', values: frames.map((f) => f.links[selectedLink]?.goodputGbps ?? 0) },
        ],
      };
    }
    return {
      unit: 'Gbps',
      series: [
        { id: 'offered', label: '端侧发送速率', color: '#6f9cff', values: frames.map((f) => f.total.offeredGbps) },
        { id: 'goodput', label: '有效 Goodput', color: '#2dd4bf', values: frames.map((f) => f.total.goodputGbps) },
      ],
    };
  }, [mode, frames, selectedLink]);

  const recentEvents = useMemo(() => {
    if (!result) return [];
    return result.events
      .filter((event) => event.timeUs <= timeUs
        && (eventFilter === 'all' ? !['rate-up', 'rate-down', 'flow-start'].includes(event.type) : event.type === eventFilter))
      .slice(-6)
      .reverse();
  }, [result, timeUs, eventFilter]);

  const total = currentFrame?.total;
  const cnpCount = useMemo(() => result?.events.filter((event) => event.type === 'cnp' && event.timeUs <= timeUs).length ?? 0, [result, timeUs]);
  const retransCount = useMemo(() => result?.events.filter((event) => event.type === 'retransmit' && event.timeUs <= timeUs).length ?? 0, [result, timeUs]);
  const cards = [
    { label: '当前 Goodput', value: formatGbps(total?.goodputGbps ?? 0), icon: Gauge, tone: 'neutral' },
    { label: 'P95 操作时延', value: result ? `${formatNumber(result.summary.p95RttUs / 1000, 1)} ms` : '—', icon: Timer, tone: 'neutral' },
    { label: 'ECN / CNP', value: `${formatNumber(total?.ecnMarks ?? 0)} / ${formatNumber(cnpCount)}`, icon: RadioTower, tone: 'neutral' },
    { label: '丢包 / 重传', value: `${formatNumber(total?.drops ?? 0)} / ${formatNumber(retransCount)}`, icon: AlertTriangle, tone: (total?.drops ?? 0) > 0 ? 'bad' : 'neutral' },
    { label: '队列高水位', value: `${formatNumber(total?.maxQueueKb ?? 0, 0)} KB`, icon: Layers3, tone: 'neutral' },
  ];

  return (
    <section className="metrics-panel">
      <div className="metrics-header">
        <div><Activity size={15} /><strong>遥测与事件</strong><span>{selectedLink ? `已选择 ${selectedLink}` : '全网聚合'}</span></div>
        <div className="metrics-actions">
          <div className="segmented-control">
            <button className={mode === 'throughput' ? 'active' : ''} onClick={() => setMode('throughput')}>吞吐</button>
            <button className={mode === 'queue' ? 'active' : ''} onClick={() => setMode('queue')}>队列</button>
            <button className={mode === 'latency' ? 'active' : ''} onClick={() => setMode('latency')}>时延</button>
          </div>
          <button className="icon-text-button" disabled={exportDisabled} onClick={onExport} title={exportDisabled ? '运行当前配置后可导出' : '导出当前实验结果'}><ArrowDownToLine size={14} />导出</button>
        </div>
      </div>
      <div className="metric-cards">
        {cards.map(({ label, value, icon: Icon, tone }) => (
          <div className={`metric-card ${tone}`} key={label}><Icon size={15} /><span>{label}</span><strong>{value}</strong></div>
        ))}
      </div>
      <div className="metrics-body">
        <div className="chart-area">
          {result ? <MetricChart frames={frames} series={chart.series} timeUs={timeUs} unit={chart.unit} onSeek={onSeek} /> : <div className="chart-empty">运行实验后显示吞吐、队列与时延曲线</div>}
        </div>
        <div className="event-console">
          <div className="event-console-header">
            <span>关键事件</span>
            <select value={eventFilter} onChange={(event) => setEventFilter(event.target.value)}>
              <option value="all">全部</option><option value="ecn">ECN</option><option value="cnp">CNP</option>
              <option value="pfc-on">PFC</option><option value="drop">丢包</option>
            </select>
          </div>
          <div className="event-list">
            {recentEvents.length ? recentEvents.map((event) => (
              <button key={event.id} className={`event-row event-${event.type}`} onClick={() => onSeek(event.timeUs)}>
                <span className="event-time">{formatTime(event.timeUs)}</span>
                <i />
                <span><strong>{EVENT_NAMES[event.type] ?? event.type}</strong><small>{event.message}</small></span>
              </button>
            )) : <div className="events-empty">当前时间点之前暂无匹配事件</div>}
          </div>
        </div>
      </div>
    </section>
  );
}
