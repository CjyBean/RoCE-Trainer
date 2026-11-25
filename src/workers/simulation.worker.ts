/// <reference lib="webworker" />

import { runSimulation } from '../sim/engine';
import type { NetworkConfig } from '../sim/types';

let generation = 0;

self.onmessage = async (event: MessageEvent<{ type: 'run' | 'cancel'; config?: NetworkConfig }>) => {
  if (event.data.type === 'cancel') {
    generation += 1;
    return;
  }
  if (!event.data.config) return;
  const current = ++generation;
  try {
    const result = await runSimulation(
      event.data.config,
      (progress) => {
        if (current === generation) self.postMessage({ type: 'progress', progress });
      },
      () => current !== generation,
    );
    if (current === generation) self.postMessage({ type: 'result', result, config: event.data.config });
  } catch (error) {
    if (current === generation && error instanceof Error && error.message !== 'SIMULATION_CANCELLED') {
      self.postMessage({ type: 'error', message: error.message });
    }
  }
};

export {};
