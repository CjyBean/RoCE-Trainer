import type { NetworkConfig, SimulationResult } from './types';
import { SimulationKernel } from './engine-kernel';

export { calculateConvergence, directedLinkKey, NetworkTopology, validateConfig } from './topology';
export { SeededRandom, SIMULATION_LIMITS } from './engine-kernel';
export type { NetworkRoute } from './topology';

export type SimulationProgress = (progress: number) => void;
export type SimulationCancellation = () => boolean;

/**
 * Run in bounded event chunks. Cancellation is cooperative and resolves with a
 * partial result (marked by a warning event/insight), rather than rejecting.
 */
export async function runSimulation(
  config: NetworkConfig,
  onProgress?: SimulationProgress,
  shouldCancel?: SimulationCancellation,
): Promise<SimulationResult> {
  return new SimulationKernel(config).run(onProgress, shouldCancel);
}
