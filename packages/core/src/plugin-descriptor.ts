/**
 * nexus-plugin.json — the plugin descriptor format.
 *
 * Declared by plugin packages to advertise their capabilities and
 * requirements. Read by the rig at install time and (future) at
 * manifest generation time.
 *
 * A plugin package MAY include a nexus-plugin.json at its root.
 * If absent, the rig discovers tools from the package's exports
 * and assumes no dependencies or migrations.
 */

/**
 * A dependency on another plugin.
 *
 * Plugin dependencies are checked at install time — if a required
 * plugin is not installed in the guild, the install fails with a
 * clear error message.
 */
export interface PluginDependency {
  /** Plugin key of the required plugin (e.g. 'nexus-stdlib'). */
  plugin: string;
}

/**
 * The nexus-plugin.json descriptor shape.
 *
 * All fields are optional — a minimal descriptor is just `{}`.
 * The rig uses this for dependency checking, migration discovery,
 * and (future) tool/engine declaration.
 */
export interface PluginDescriptor {
  /**
   * Human-readable plugin description.
   */
  description?: string;

  /**
   * Plugins this plugin depends on.
   * Checked at install time — missing dependencies cause install to fail.
   */
  dependencies?: PluginDependency[];

  /**
   * Path to migrations directory, relative to the package root.
   * Contains numbered SQL files (e.g. 001-create-assessments.sql).
   * Migrations are namespaced by plugin key and applied in order.
   *
   * Not implemented yet — reserved for the migrations commission.
   */
  migrations?: string;
}
