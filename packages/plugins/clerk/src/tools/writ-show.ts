import { z } from 'zod';
import { guild, shortId } from '@shardworks/nexus-core';
import { tool } from '@shardworks/tools-apparatus';
import type {
  ClerkApi,
  WritDoc,
  WritLinks,
  WritPhase,
  WritReferenceWithPresentation,
  WritPresentationClassification,
} from '../types.ts';
import { derivePresentation } from '../writ-presentation.ts';

/**
 * Shape returned by writ-show in JSON mode. Preserves the existing
 * top-level `WritDoc` fields and adds the presentation projection,
 * parent reference, children summary/items, and links sub-document.
 */
interface WritShowResult extends WritDoc {
  classification: WritPresentationClassification;
  allowedTransitions: string[];
  links: WritLinks;
  parent: WritReferenceWithPresentation | null;
  children: { summary: Record<WritPhase, number>; items: WritReferenceWithPresentation[] };
}

/**
 * Render the lifecycle-aware text view of a writ-show response per D3:
 * type, state with classification + attrs annotation, title, codex,
 * parent reference, timestamps, resolution, allowed-transitions list,
 * descendant phase summary, and links.
 *
 * The state annotation reads classification verbatim from the embedded
 * projection and reads attrs from the writ's registered type config (a
 * single closure-captured lookup). Unknown classifications surface as
 * `unknown` and the renderer continues — matching writ-tree's D17
 * fallback so a single legacy writ does not abort the detail view.
 */
function renderShow(
  result: WritShowResult,
  attrs: readonly string[],
): string {
  const lines: string[] = [];

  // ── Identity row ──
  lines.push(`Writ:    ${result.title ?? ''}`);
  lines.push(`Id:      ${shortId(result.id)}  (${result.id})`);
  lines.push(`Type:    ${result.type}`);

  // ── State annotation: phase, classification, attrs ──
  const attrSegment = attrs.length > 0 ? `, attrs: [${attrs.join(', ')}]` : '';
  lines.push(`State:   ${result.phase}  (classification: ${result.classification}${attrSegment})`);

  // ── Allowed transitions (empty for terminal/unknown) ──
  const transitionsLabel = result.allowedTransitions.length === 0
    ? '(none — terminal or unknown state)'
    : result.allowedTransitions.join(', ');
  lines.push(`Transitions: ${transitionsLabel}`);

  if (result.codex) {
    lines.push(`Codex:   ${result.codex}`);
  }
  if (result.parent) {
    lines.push(`Parent:  ${shortId(result.parent.id)}  ${result.parent.title}  (${result.parent.phase})`);
  }

  // ── Timestamps ──
  lines.push('');
  lines.push(`Created: ${result.createdAt}`);
  lines.push(`Updated: ${result.updatedAt}`);
  if (result.resolvedAt) {
    lines.push(`Resolved: ${result.resolvedAt}`);
  }
  if (result.resolution) {
    lines.push(`Resolution: ${result.resolution}`);
  }

  // ── Body ──
  if (result.body) {
    lines.push('');
    lines.push('Body:');
    for (const ln of result.body.split('\n')) lines.push(`  ${ln}`);
  }

  // ── Descendant phase summary ──
  const summaryEntries = Object.entries(result.children.summary);
  if (summaryEntries.length > 0) {
    lines.push('');
    lines.push('Descendants:');
    for (const [phase, count] of summaryEntries) {
      lines.push(`  ${phase}: ${count}`);
    }
  }

  // ── Direct-children list ──
  if (result.children.items.length > 0) {
    lines.push('');
    lines.push('Children:');
    for (const child of result.children.items) {
      lines.push(`  ${shortId(child.id)}  ${child.phase.padEnd(10)}  ${child.title}`);
    }
  }

  // ── Links ──
  const outbound = result.links.outbound ?? [];
  const inbound = result.links.inbound ?? [];
  if (outbound.length > 0 || inbound.length > 0) {
    lines.push('');
    lines.push('Links:');
    for (const l of outbound) {
      lines.push(`  → ${shortId(l.targetId)}  (${l.label})`);
    }
    for (const l of inbound) {
      lines.push(`  ← ${shortId(l.sourceId)}  (${l.label})`);
    }
  }

  return lines.join('\n');
}

export default tool({
  name: 'writ-show',
  description: 'Show full detail for a writ',
  instructions:
    'Returns the complete writ record including its current phase, timestamps, body text, ' +
    'resolution, parent context, and children. The `children.summary` field is a ' +
    'phase-keyed count of the entire descendant subtree beneath this writ (grandchildren ' +
    'and deeper included; the writ itself is excluded). The `children.items` list stays ' +
    'scoped to direct children only. The default `--format text` renders a lifecycle-aware ' +
    'block (state classification + attrs, allowed transitions, descendant summary, links); ' +
    'pass `--format json` for the structured response.',
  params: {
    id: z.string().describe('Writ id'),
    format: z
      .enum(['text', 'json'])
      .default('text')
      .describe('Output format. "text" renders the lifecycle-aware block (default). "json" returns the structured response.'),
  },
  permission: 'read',
  handler: async (params) => {
    const clerk = guild().apparatus<ClerkApi>('clerk');
    const resolvedId = await clerk.resolveId(params.id);
    const [writ, links, summary] = await Promise.all([
      clerk.show(resolvedId),
      clerk.links(resolvedId),
      clerk.countDescendantsByPhase(resolvedId),
    ]);

    const lookupConfig = (name: string) => clerk.getWritTypeConfig(name);

    /**
     * Project a writ-shaped record onto the parent/child reference shape
     * with embedded presentation fields. Used both for the `parent`
     * context and each entry in `children.items` so a renderer can pick
     * badge classes uniformly without a second registry lookup.
     */
    function presentReference(
      ref: { id: string; title: string; type: string; phase: string },
    ): WritReferenceWithPresentation {
      const projection = derivePresentation(ref, lookupConfig);
      return {
        id: ref.id,
        title: ref.title,
        type: ref.type,
        phase: ref.phase,
        classification: projection.classification,
        allowedTransitions: projection.allowedTransitions,
      };
    }

    // Parent context
    let parent: WritReferenceWithPresentation | null = null;
    if (writ.parentId) {
      const parentWrit = await clerk.show(writ.parentId);
      parent = presentReference(parentWrit);
    }

    // Direct-children list — `items` stays direct-children-only. The subtree-wide
    // phase tally lives in `summary` (computed via clerk.countDescendantsByPhase).
    const childWrits = await clerk.list({ parentId: writ.id, limit: 1000 });
    const items: WritReferenceWithPresentation[] = childWrits.map(presentReference);

    // Top-level writ also carries classification + allowedTransitions so
    // the detail-view renderer can derive its action buttons from a
    // single shape.
    const topProjection = derivePresentation(writ, lookupConfig);

    const result: WritShowResult = {
      ...writ,
      classification: topProjection.classification,
      allowedTransitions: topProjection.allowedTransitions,
      links,
      parent,
      children: { summary, items },
    };

    if (params.format === 'json') {
      return result;
    }

    return renderShow(result, topProjection.attrs);
  },
});
