export * from '../../rig-descriptor.ts';

// Backward-compat aliases — code that imported PluginDescriptor/PluginDependency
// from legacy paths still resolves correctly.
export type { RigDescriptor as PluginDescriptor, RigDependency as PluginDependency } from '../../rig-descriptor.ts';
