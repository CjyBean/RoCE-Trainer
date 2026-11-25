import { useMemo } from 'react';
import { Pause, Play, RotateCcw, SkipBack, SkipForward } from 'lucide-react';
import type { PlaybackSpeed, SimulationEvent } from '../sim/types';
import { formatTime } from '../utils/format';

interface TimelineProps {
  timeUs: number;
  durationUs: number;
  events: SimulationEvent[];
  playing: boolean;
  speed: PlaybackSpeed;
  disabled: boolean;
  onPlay: () => void;
  onSpeed: (speed: PlaybackSpeed) => void;
  onSeek: (timeUs: number) => void;
  onStep: (direction: number) => void;
  onRestart: () => void;
}

const eventColors: Record<string, string> = {
  ecn: '#d97706', cnp: '#7c3aed', 'pfc-on': '#e11d48', 'pfc-off': '#059669',
  drop: '#dc2626', retransmit: '#ea580c', 'rate-down': '#d97706', 'rate-up': '#059669',
};

const markerTypes = new Set(['ecn', 'cnp', 'pfc-on', 'pfc-off', 'drop', 'retransmit', 'flow-complete']);

function uniformSample(events: SimulationEvent[], count: number): SimulationEvent[] {
  if (events.length <= count) return events;
  if (count <= 1) return events.slice(0, Math.max(0, count));
  const selected = new Set<SimulationEvent>();
  for (let index = 0; index < count; index += 1) selected.add(events[Math.floor((index * (events.length - 1)) / (count - 1))]);
  return [...selected];
}

export function sampleTimelineEvents(events: SimulationEvent[], maximum = 300): SimulationEvent[] {
  const candidates = events.filter((event) => markerTypes.has(event.type));
  if (candidates.length <= maximum) return candidates;
  const regular = candidates.filter((event) => event.type === 'ecn' || event.type === 'cnp');
  const critical = candidates.filter((event) => event.type !== 'ecn' && event.type !== 'cnp');
  let regularCount = Math.min(regular.length, Math.floor(maximum * 0.6));
  let criticalCount = Math.min(critical.length, maximum - regularCount);
  regularCount = Math.min(regular.length, maximum - criticalCount);
  criticalCount = Math.min(critical.length, maximum - regularCount);
  return [...uniformSample(regular, regularCount), ...uniformSample(critical, criticalCount)]
    .sort((a, b) => a.timeUs - b.timeUs || a.id - b.id);
}

export function Timeline({ timeUs, durationUs, events, playing, speed, disabled, onPlay, onSpeed, onSeek, onStep, onRestart }: TimelineProps) {
  const visibleEvents = useMemo(() => sampleTimelineEvents(events), [events]);
  return (
    <div className="timeline-panel">
      <div className="playback-buttons">
        <button title="从头播放" disabled={disabled} onClick={onRestart}><RotateCcw size={15} /></button>
        <button title="上一帧" disabled={disabled} onClick={() => onStep(-1)}><SkipBack size={16} /></button>
        <button className="play-button" title={playing ? '暂停' : '播放'} disabled={disabled} onClick={onPlay}>
          {playing ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}
        </button>
        <button title="下一帧" disabled={disabled} onClick={() => onStep(1)}><SkipForward size={16} /></button>
      </div>
      <div className="timeline-main">
        <div className="timeline-labels">
          <span>仿真时间轴</span>
          <span className="time-readout">{formatTime(timeUs)} <i>/</i> {formatTime(durationUs)}</span>
        </div>
        <div className="timeline-track-wrap">
          <input
            aria-label="仿真时间"
            type="range"
            min={0}
            max={Math.max(1, durationUs)}
            step={Math.max(1, durationUs / 2000)}
            value={Math.min(timeUs, durationUs)}
            disabled={disabled}
            onChange={(event) => onSeek(Number(event.target.value))}
            style={{ '--timeline-progress': `${durationUs ? (timeUs / durationUs) * 100 : 0}%` } as React.CSSProperties}
          />
          <div className="timeline-events">
            {visibleEvents.map((event) => (
              <button
                key={event.id}
                className="timeline-event-marker"
                style={{ left: `${durationUs ? (event.timeUs / durationUs) * 100 : 0}%`, '--event-color': eventColors[event.type] ?? '#8b9bb4' } as React.CSSProperties}
                title={`${formatTime(event.timeUs)} · ${event.message}`}
                onClick={() => onSeek(event.timeUs)}
              />
            ))}
          </div>
        </div>
      </div>
      <label className="speed-control">
        <span>播放速度</span>
        <select value={speed} disabled={disabled} onChange={(event) => onSpeed(Number(event.target.value) as PlaybackSpeed)}>
          {[0.1, 0.5, 1, 10, 100].map((value) => <option key={value} value={value}>{value}×</option>)}
        </select>
      </label>
    </div>
  );
}
