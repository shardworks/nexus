/**
 * rig.json — the rig descriptor format.
 *
 * Declared by rig packages to advertise their capabilities and
 * requirements. Read by mainspring at install time and (future) at
 * manifest generation time.
 *
 * A rig package MAY include a rig.json at its root.
 * If absent, mainspring discovers tools from the package's exports
 * and assumes no dependencies or migrations.
 */

/**
 * A dependency on another rig.
 *
 * Rig dependencies are checked at install time — if a required
 * rig is not installed in the guild, the install fails with a
 * clear error message.
 */
export interface PluginDependency {
  /** Rig key of the required rig (e.g. 'nexus-stdlib'). */
  plugin: string;
}

/**
 * The rig.json descriptor shape.
 *
 * All fields are optional — a minimal descriptor is just `{}`.
 * Mainspring uses this for dependency checking, migration discovery,
 * and (future) tool/engine declaration.
 */
export interface PluginDescriptor {
  /**
   * Human-readable rig description.
   */
  description?: string;

  /**
   * Rigs this rig depends on.
   * Checked at install time — missing dependencies cause install to fail.
   */
  dependencies?: PluginDependency[];

  /**
   * Path to migrations directory, relative to the package root.
   * Contains numbered SQL files (e.g. 001-create-assessments.sql).
   * Migrations are namespaced by rig key and applied in order.
   *
   * Not implemented yet — reserved for the migrations commission.
   */
  migrations?: string;
}
