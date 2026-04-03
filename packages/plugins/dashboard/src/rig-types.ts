/**
 * Local type stubs for Spider rig documents read via Stacks readBook().
 */

export interface EngineInstance {
  id: string;
  designId: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  upstream: string[];
  givensSpec: Record<string, unknown>;
  yields?: unknown;
  error?: string;
  sessionId?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface RigDoc {
  id: string;
  writId: string;
  status: 'running' | 'completed' | 'failed';
  engines: EngineInstance[];
  [key: string]: unknown;
}
