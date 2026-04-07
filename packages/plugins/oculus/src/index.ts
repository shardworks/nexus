/**
 * @shardworks/oculus-apparatus — The Oculus.
 *
 * Web dashboard apparatus for the guild. Serves pages contributed by plugins,
 * exposes guild tools as REST endpoints, and provides a unified web interface.
 */

import { createOculus } from './oculus.ts';

export {
  type OculusApi,
  type OculusConfig,
  type OculusKit,
  type PageContribution,
  type RouteContribution,
} from './types.ts';

export { createOculus } from './oculus.ts';

import type { OculusConfig } from './types.ts';

declare module '@shardworks/nexus-core' {
  interface GuildConfig {
    oculus?: OculusConfig;
  }
}

export default createOculus();
