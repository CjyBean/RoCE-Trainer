import { useCallback, useEffect, useRef, useState } from 'react';
import type { NetworkConfig, SimulationResult } from '../sim/types';

export function useSimulation() {
  const workerRef = useRef<Worker | null>(null);
  const completionRef = useRef<((config: NetworkConfig) => void) | null>(null);
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const worker = new Worker(new URL('../workers/simulation.worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;
    worker.onmessage = (event) => {
      const data = event.data;
      if (data.type === 'progress') setProgress(data.progress);
      if (data.type === 'result') {
        setResult(data.result);
        setRunning(false);
        setProgress(1);
        completionRef.current?.(data.config);
      }
      if (data.type === 'error') {
        setError(data.message);
        setRunning(false);
      }
    };
    worker.onerror = (event) => {
      setError(event.message || '仿真 Worker 运行失败');
      setRunning(false);
    };
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  const run = useCallback((config: NetworkConfig, onComplete?: (config: NetworkConfig) => void) => {
    const worker = workerRef.current;
    if (!worker) return;
    setError(null);
    setRunning(true);
    setProgress(0);
    completionRef.current = onComplete ?? null;
    worker.postMessage({ type: 'cancel' });
    worker.postMessage({ type: 'run', config: structuredClone(config) });
  }, []);

  const cancel = useCallback(() => {
    workerRef.current?.postMessage({ type: 'cancel' });
    completionRef.current = null;
    setRunning(false);
  }, []);

  return { result, running, progress, error, run, cancel, clearError: () => setError(null) };
}
