import { tool } from '@shardworks/tools-apparatus';

/**
 * `nsg clock list` — stub.
 *
 * The real implementation arrives with the CLI subcommand commission
 * (task 6), which will list recorded events and/or standing orders.
 * For now, the command exists so the `nsg clock` namespace is claimed
 * in the auto-grouped CLI help — the auto-group requires ≥2 sibling
 * `clock-*` tools.
 */
export default tool({
  name: 'clock-list',
  description: 'List Clockworks events/standing orders (stub — arrives with task 6).',
  instructions:
    'Placeholder command for the Clockworks list surface. The real ' +
    'implementation arrives with the CLI-subcommands commission.',
  params: {},
  permission: 'clockworks:read',
  handler: (): { ok: false; message: string } => {
    const message =
      'clockworks: `nsg clock list` is not yet implemented — arrives with task 6 (CLI subcommands).';
    console.error(message);
    return { ok: false, message };
  },
});
