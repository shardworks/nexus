import { tool } from '@shardworks/tools-apparatus';

/**
 * `nsg clock status` — stub.
 *
 * The real implementation arrives with the daemon commission (task 10),
 * which will report the Clockworks' run state (daemon PID, queue
 * depth, last-processed event, etc.). For now, the command exists so
 * the `nsg clock` namespace is claimed in the auto-grouped CLI help —
 * the auto-group requires ≥2 sibling `clock-*` tools.
 */
export default tool({
  name: 'clock-status',
  description: 'Clockworks daemon status (stub — arrives with task 10).',
  instructions:
    'Placeholder command for the Clockworks status surface. The real ' +
    'implementation arrives with the daemon commission.',
  params: {},
  permission: 'clockworks:read',
  handler: (): { ok: false; message: string } => {
    const message =
      'clockworks: `nsg clock status` is not yet implemented — arrives with task 10 (daemon).';
    // Emit to stderr so pipelines that capture stdout don't mistake
    // the placeholder for data; return a structured value so callers
    // using the tool programmatically (MCP, future scripted invocations)
    // get a stable shape.
    console.error(message);
    return { ok: false, message };
  },
});

