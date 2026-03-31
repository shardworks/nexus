/**
 * rig.json — the rig descriptor format.
 *
 * Declared by rig packages to advertise their capabilities and
 * requirements. Read by arbor at install time.
 *
 * A rig package MAY include a rig.json at its root.
 * If absent, arbor discovers tools from the package's exports
 * and assumes no dependencies.
 */

/**
 * A dependency on another rig.
 *
 * Rig dependencies are checked at install time — if a required
 * rig is not installed in the guild, the install fails with a
 * clear error message.
 */
export interface RigDependency {
  /** Rig key of the required rig (e.g. 'nexus-stdlib'). */
  rig: string;
}

/**
 * The rig.json descriptor shape.
 *
 * All fields are optional — a minimal descriptor is just `{}`.
 * Arbor uses this for dependency checking at install time.
 */
export interface RigDescriptor {
  /**
   * Human-readable rig description.
   */
  description?: string;

  /**
   * Rigs this rig depends on.
   * Checked at install time — missing dependencies cause install to fail.
   */
  dependencies?: RigDependency[];
}
