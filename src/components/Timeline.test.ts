import { describe, expect, it } from 'vitest';
import type { SimulationEvent } from '../sim/types';
import { sampleTimelineEvents } from './Timeline';

function event(id: number, type: SimulationEvent['type'], timeUs: number): SimulationEvent {
  return { id, type, timeUs, message: `event ${id}` };
}

describe('时间轴事件抽样', () => {
  it('早期大量 ECN 不会淹没后续丢包、PFC 与完成事件', () => {
    const events: SimulationEvent[] = [];
    for (let index = 0; index < 5000; index += 1) events.push(event(index, 'ecn', index));
    events.push(event(5001, 'drop', 8000));
    events.push(event(5002, 'pfc-on', 9000));
    events.push(event(5003, 'flow-complete', 10_000));
    const sampled = sampleTimelineEvents(events);
    expect(sampled.length).toBeLessThanOrEqual(300);
    expect(sampled.some((item) => item.type === 'drop')).toBe(true);
    expect(sampled.some((item) => item.type === 'pfc-on')).toBe(true);
    expect(sampled.some((item) => item.type === 'flow-complete')).toBe(true);
    expect(sampled.at(-1)?.type).toBe('flow-complete');
    expect(sampled).toEqual([...sampled].sort((a, b) => a.timeUs - b.timeUs || a.id - b.id));
  });

  it('小于上限时原样保留关键事件', () => {
    const events = [event(1, 'ecn', 1), event(2, 'cnp', 2), event(3, 'drop', 3)];
    expect(sampleTimelineEvents(events)).toEqual(events);
  });
});
