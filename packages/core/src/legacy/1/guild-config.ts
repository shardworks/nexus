export * from '../../guild-config.ts';

// Backward-compat aliases — ToolEntry and TrainingEntry were merged into InstalledCapability.
// Legacy code importing these names continues to work; new code should use InstalledCapability.
export type { InstalledCapability as ToolEntry, InstalledCapability as TrainingEntry } from '../../guild-config.ts';
