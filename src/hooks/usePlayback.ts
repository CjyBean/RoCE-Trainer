import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MetricFrame, PlaybackSpeed, SimulationResult } from '../sim/types';

function frameAt(frames: MetricFrame[], timeUs: number): MetricFrame | null {
  if (!frames.length) return null;
  let low = 0;
  let high = frames.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (frames[middle].timeUs <= timeUs) low = middle + 1;
    else high = middle - 1;
  }
  return frames[Math.max(0, high)];
}

export function usePlayback(result: SimulationResult | null) {
  const [timeUs, setTimeUs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<PlaybackSpeed>(10);
  const animationRef = useRef<number | null>(null);
  const lastWallRef = useRef<number | null>(null);
  const durationUs = result?.summary.durationUs ?? 0;

  useEffect(() => {
    setTimeUs(0);
    setPlaying(Boolean(result));
  }, [result]);

  useEffect(() => {
    if (!playing || !result) return;
    const tick = (wallTime: number) => {
      const previous = lastWallRef.current ?? wallTime;
      const deltaMs = Math.min(100, wallTime - previous);
      lastWallRef.current = wallTime;
      setTimeUs((current) => {
        // Teaching time base: at 1×, one real second displays 1 ms of network time.
        const next = current + deltaMs * speed;
        if (next >= durationUs) {
          setPlaying(false);
          return durationUs;
        }
        return next;
      });
      if (lastWallRef.current !== null) animationRef.current = requestAnimationFrame(tick);
    };
    animationRef.current = requestAnimationFrame(tick);
    return () => {
      if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
      lastWallRef.current = null;
    };
  }, [playing, result, speed, durationUs]);

  const currentFrame = useMemo(() => frameAt(result?.frames ?? [], timeUs), [result, timeUs]);
  const currentFrameIndex = useMemo(() => {
    if (!result?.frames.length || !currentFrame) return 0;
    return result.frames.indexOf(currentFrame);
  }, [result, currentFrame]);

  const step = useCallback((direction = 1) => {
    if (!result?.frames.length) return;
    setPlaying(false);
    const nextIndex = Math.max(0, Math.min(result.frames.length - 1, currentFrameIndex + direction));
    setTimeUs(result.frames[nextIndex].timeUs);
  }, [result, currentFrameIndex]);

  const seek = useCallback((nextTime: number) => {
    setTimeUs(Math.max(0, Math.min(durationUs, nextTime)));
  }, [durationUs]);

  const restart = useCallback(() => {
    setTimeUs(0);
    setPlaying(true);
  }, []);

  return {
    timeUs,
    playing,
    speed,
    currentFrame,
    setPlaying,
    setSpeed,
    step,
    seek,
    restart,
  };
}
