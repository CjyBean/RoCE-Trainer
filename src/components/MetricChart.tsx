import { useMemo, useRef } from 'react';
import type { MetricFrame } from '../sim/types';
import { clamp, formatTime } from '../utils/format';

export interface ChartSeries {
  id: string;
  label: string;
  color: string;
  values: number[];
}

interface MetricChartProps {
  frames: MetricFrame[];
  series: ChartSeries[];
  timeUs: number;
  unit: string;
  onSeek: (timeUs: number) => void;
}

const WIDTH = 760;
const HEIGHT = 190;
const LEFT = 48;
const RIGHT = 16;
const TOP = 18;
const BOTTOM = 28;
const MAX_POINTS = 1200;

export function chartMaxValue(series: ChartSeries[]): number {
  let max = 1;
  for (const item of series) {
    for (const value of item.values) {
      if (Number.isFinite(value) && value > max) max = value;
    }
  }
  return max * 1.12;
}

export function sampleIndices(length: number, maximum = MAX_POINTS): number[] {
  if (length <= 0) return [];
  if (length <= maximum) return Array.from({ length }, (_, index) => index);
  const count = Math.max(2, maximum);
  const indices = new Set<number>([0, length - 1]);
  for (let index = 1; index < count - 1; index += 1) indices.add(Math.floor((index * (length - 1)) / (count - 1)));
  return [...indices].sort((a, b) => a - b);
}

export function MetricChart({ frames, series, timeUs, unit, onSeek }: MetricChartProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const maxValue = useMemo(() => chartMaxValue(series), [series]);
  const duration = frames.at(-1)?.timeUs ?? 1;
  const plotWidth = WIDTH - LEFT - RIGHT;
  const plotHeight = HEIGHT - TOP - BOTTOM;
  const xAt = (time: number) => LEFT + (time / Math.max(1, duration)) * plotWidth;
  const yAt = (value: number) => TOP + plotHeight - (value / maxValue) * plotHeight;

  const seekFromPointer = (clientX: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const svgX = ((clientX - rect.left) / rect.width) * WIDTH;
    onSeek(clamp(((svgX - LEFT) / plotWidth) * duration, 0, duration));
  };

  return (
    <div className="metric-chart-wrap">
      <div className="chart-legend">
        {series.map((item) => <span key={item.id}><i style={{ background: item.color }} />{item.label}</span>)}
      </div>
      <svg
        ref={svgRef}
        className="metric-chart"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        onPointerDown={(event) => {
          seekFromPointer(event.clientX);
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) seekFromPointer(event.clientX);
        }}
      >
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
          const y = TOP + ratio * plotHeight;
          return (
            <g key={ratio}>
              <line x1={LEFT} x2={WIDTH - RIGHT} y1={y} y2={y} className="chart-grid" />
              <text x={LEFT - 8} y={y + 3} textAnchor="end" className="chart-axis-label">{((1 - ratio) * maxValue).toFixed(maxValue < 10 ? 1 : 0)}</text>
            </g>
          );
        })}
        <text x={8} y={12} className="chart-axis-unit">{unit}</text>
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => (
          <text key={ratio} x={LEFT + ratio * plotWidth} y={HEIGHT - 8} textAnchor={ratio === 0 ? 'start' : ratio === 1 ? 'end' : 'middle'} className="chart-axis-label">
            {formatTime(duration * ratio)}
          </text>
        ))}
        {series.map((item) => {
          const points = sampleIndices(Math.min(item.values.length, frames.length)).map((index) => {
            const frame = frames[index];
            return `${xAt(frame?.timeUs ?? 0)},${yAt(item.values[index])}`;
          }).join(' ');
          return <polyline key={item.id} points={points} fill="none" stroke={item.color} strokeWidth={1.7} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />;
        })}
        <line x1={xAt(timeUs)} x2={xAt(timeUs)} y1={TOP} y2={TOP + plotHeight} className="chart-cursor" />
      </svg>
    </div>
  );
}
