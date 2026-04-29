/**
 * Shared text/JSON rendering helpers used by the cartograph CLI tools.
 *
 * Each cartograph type (vision, charge, piece) has its own create/show/list/
 * patch/transition tools, but the show and list rendering behavior is
 * byte-shape identical across the three. These helpers centralize the
 * composition (cartograph projection + writ row + links + descendants
 * summary + children list + parent ref) and the table/block rendering
 * so the per-type tools stay thin.
 *
 * Decision references (from the commission spec):
 *   - D7 / D8  — show composes the doc with the writ row; JSON shape is
 *               `{ ...doc, writ: { ... } }` to avoid id/timestamp collisions.
 *   - D9       — list table columns: [stage, id, codex, title, created],
 *               with per-row title fetch from the writ rows (N+1 cost).
 *   - D18      — show text-mode mirrors writ-show's lifecycle-aware block.
 */

import { shortId } from '@shardworks/nexus-core';
import type {
  ClerkApi,
  WritDoc,
  WritLinks,
  WritPhase,
  WritTypeConfig,
  WritTypeStateAttr,
  WritTypeStateClassification,
} from '@shardworks/clerk-apparatus';

// ── Types ────────────────────────────────────────────────────────────

/** Subset of `WritDoc` fields nested under `writ` in the show JSON shape (D8). */
export interface WritProjection {
  id: string;
  title: string;
  body: string;
  type: string;
  phase: string;
  parentId?: string;
  codex?: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
  resolution?: string;
}

/** Reference shape for parent + children entries in a show response. */
export interface WritReference {
  id: string;
  title: string;
  type: string;
  phase: string;
}

/**
 * Composed result returned by `composeShow(...)`. The cartograph
 * projection fields land at the top level (so the response is
 * recognizably the per-type doc); the underlying writ row sits nested
 * under `writ` to avoid id/timestamp field collisions (D8). The
 * supplementary fields (`parent`, `children`, `links`) drive the
 * text-mode renderer.
 */
export interface CartographShowResult<TDoc extends Record<string, unknown>> {
  doc: TDoc;
  writ: WritProjection;
  links: WritLinks;
  parent: WritReference | null;
  children: { summary: Record<WritPhase, number>; items: WritReference[] };
  /** Classification + attrs for the top-level writ; drives the text block. */
  classification: WritTypeStateClassification | 'unknown';
  allowedTransitions: string[];
  attrs: WritTypeStateAttr[];
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Project a writ-shaped record onto the JSON-mode subset declared by D8.
 * Only the fields that survive the `{ ...doc, writ }` nesting are kept;
 * additional metadata (`type`, `phase`, `parentId`, `resolvedAt`,
 * `resolution`) ride alongside so a reader does not need a second
 * round-trip to clerk.show.
 */
export function projectWrit(writ: WritDoc): WritProjection {
  const projection: WritProjection = {
    id: writ.id,
    title: writ.title,
    body: writ.body,
    type: writ.type,
    phase: writ.phase,
    createdAt: writ.createdAt,
    updatedAt: writ.updatedAt,
  };
  if (writ.parentId !== undefined) projection.parentId = writ.parentId;
  if (writ.codex !== undefined) projection.codex = writ.codex;
  if (writ.resolvedAt !== undefined) projection.resolvedAt = writ.resolvedAt;
  if (writ.resolution !== undefined) projection.resolution = writ.resolution;
  return projection;
}

/**
 * Project a writ row onto the bare reference shape used in `parent` and
 * `children.items`. Tighter than `WritProjection` — the reference shape
 * carries only what the renderer prints.
 */
function projectReference(writ: WritDoc): WritReference {
  return { id: writ.id, title: writ.title, type: writ.type, phase: writ.phase };
}

/**
 * Look up the lifecycle classification + outbound transitions + attrs for
 * a writ. Mirrors clerk's `derivePresentation` by hand because that helper
 * is not exported from the package's public surface; replicating the
 * minimal logic lets cartograph stay decoupled from clerk's internals.
 */
function projectPresentation(
  writ: Pick<WritDoc, 'type' | 'phase'>,
  getConfig: (name: string) => WritTypeConfig | undefined,
): {
  classification: WritTypeStateClassification | 'unknown';
  allowedTransitions: string[];
  attrs: WritTypeStateAttr[];
} {
  const config = getConfig(writ.type);
  if (!config) return { classification: 'unknown', allowedTransitions: [], attrs: [] };
  const state = config.states.find((s) => s.name === writ.phase);
  if (!state) return { classification: 'unknown', allowedTransitions: [], attrs: [] };
  return {
    classification: state.classification,
    allowedTransitions: [...state.allowedTransitions],
    attrs: [...(state.attrs ?? [])],
  };
}

/**
 * Compose the show response for a cartograph type. The caller supplies
 * the typed-API show result (the cartograph projection) and the clerk
 * apparatus handle; this helper fetches the writ row, parent ref,
 * children list, descendants summary, and links in parallel.
 */
export async function composeShow<TDoc extends Record<string, unknown>>(
  doc: TDoc,
  id: string,
  clerk: ClerkApi,
): Promise<CartographShowResult<TDoc>> {
  const [writ, links, summary] = await Promise.all([
    clerk.show(id),
    clerk.links(id),
    clerk.countDescendantsByPhase(id),
  ]);

  let parent: WritReference | null = null;
  if (writ.parentId) {
    const parentWrit = await clerk.show(writ.parentId);
    parent = projectReference(parentWrit);
  }

  const childWrits = await clerk.list({ parentId: writ.id, limit: 1000 });
  const items: WritReference[] = childWrits.map(projectReference);

  const presentation = projectPresentation(writ, (name) =>
    clerk.getWritTypeConfig(name),
  );

  return {
    doc,
    writ: projectWrit(writ),
    links,
    parent,
    children: { summary, items },
    classification: presentation.classification,
    allowedTransitions: presentation.allowedTransitions,
    attrs: presentation.attrs,
  };
}

// ── Show text rendering ──────────────────────────────────────────────

/**
 * Render the lifecycle-aware text block for a cartograph show response
 * (D18). Mirrors writ-show's structural shape: identity, state
 * (classification + attrs), allowed transitions, codex, parent ref,
 * timestamps, body, descendants summary, children list, links. Adds a
 * cartograph-specific `Stage:` row above `State:` so the patron sees both
 * the writ phase and the `ext['cartograph'].stage` value at a glance.
 */
export function renderShowText<TDoc extends { stage: string }>(
  typeLabel: string,
  result: CartographShowResult<TDoc>,
): string {
  const { doc, writ, parent, children, links, classification, allowedTransitions, attrs } = result;
  const lines: string[] = [];

  // ── Identity row ──
  lines.push(`${typeLabel}:    ${writ.title}`);
  lines.push(`Id:        ${shortId(writ.id)}  (${writ.id})`);
  lines.push(`Type:      ${writ.type}`);

  // ── Stage / State annotation ──
  lines.push(`Stage:     ${doc.stage}`);
  const attrSegment = attrs.length > 0 ? `, attrs: [${attrs.join(', ')}]` : '';
  lines.push(`Phase:     ${writ.phase}  (classification: ${classification}${attrSegment})`);

  const transitionsLabel =
    allowedTransitions.length === 0
      ? '(none — terminal or unknown state)'
      : allowedTransitions.join(', ');
  lines.push(`Transitions: ${transitionsLabel}`);

  if (writ.codex) lines.push(`Codex:     ${writ.codex}`);
  if (parent) {
    lines.push(`Parent:    ${shortId(parent.id)}  ${parent.title}  (${parent.phase})`);
  }

  // ── Timestamps ──
  lines.push('');
  lines.push(`Created:   ${writ.createdAt}`);
  lines.push(`Updated:   ${writ.updatedAt}`);
  if (writ.resolvedAt) lines.push(`Resolved:  ${writ.resolvedAt}`);
  if (writ.resolution) lines.push(`Resolution: ${writ.resolution}`);

  // ── Body ──
  if (writ.body) {
    lines.push('');
    lines.push('Body:');
    for (const ln of writ.body.split('\n')) lines.push(`  ${ln}`);
  }

  // ── Descendant phase summary ──
  const summaryEntries = Object.entries(children.summary);
  if (summaryEntries.length > 0) {
    lines.push('');
    lines.push('Descendants:');
    for (const [phase, count] of summaryEntries) {
      lines.push(`  ${phase}: ${count}`);
    }
  }

  // ── Direct-children list ──
  if (children.items.length > 0) {
    lines.push('');
    lines.push('Children:');
    for (const child of children.items) {
      lines.push(`  ${shortId(child.id)}  ${child.phase.padEnd(10)}  ${child.title}`);
    }
  }

  // ── Links ──
  const outbound = links.outbound ?? [];
  const inbound = links.inbound ?? [];
  if (outbound.length > 0 || inbound.length > 0) {
    lines.push('');
    lines.push('Links:');
    for (const l of outbound) lines.push(`  → ${shortId(l.targetId)}  (${l.label})`);
    for (const l of inbound) lines.push(`  ← ${shortId(l.sourceId)}  (${l.label})`);
  }

  return lines.join('\n');
}

/**
 * Build the JSON output shape per D8: `{ ...doc, writ: { ... } }`. Doc
 * fields land at the top level; writ-side fields stay nested to dodge
 * id/timestamp collisions.
 */
export function renderShowJson<TDoc extends Record<string, unknown>>(
  result: CartographShowResult<TDoc>,
): TDoc & { writ: WritProjection } {
  return { ...result.doc, writ: result.writ };
}

// ── List text rendering ──────────────────────────────────────────────

/**
 * Row shape consumed by `renderListTable`. The table columns are
 * `[stage, id, codex, title, created]` per D9; the per-row title is
 * fetched from the writ row by the caller (N+1 cost is acceptable for v0).
 */
export interface ListRow {
  stage: string;
  id: string;
  codex?: string;
  title: string;
  createdAt: string;
}

/**
 * Render a tabular text view of cartograph list rows (D9). Columns are
 * padded to the widest cell so heterogeneous values stay aligned; the
 * header row uses the literal column names declared in the spec.
 */
export function renderListTable(rows: ListRow[]): string {
  if (rows.length === 0) return 'No rows found.';

  const headers: [keyof ListRow | 'created' | 'id', string][] = [
    ['stage', 'STAGE'],
    ['id', 'ID'],
    ['codex', 'CODEX'],
    ['title', 'TITLE'],
    ['created', 'CREATED'],
  ];

  function cell(row: ListRow, col: typeof headers[number][0]): string {
    if (col === 'stage') return row.stage ?? '';
    if (col === 'id') return shortId(row.id);
    if (col === 'codex') return row.codex ?? '';
    if (col === 'title') return row.title ?? '';
    if (col === 'created') return row.createdAt ?? '';
    return '';
  }

  const widths = headers.map(([key, label]) => {
    let w = label.length;
    for (const row of rows) {
      const cellLen = cell(row, key).length;
      if (cellLen > w) w = cellLen;
    }
    return w;
  });

  const lines: string[] = [];
  lines.push(headers.map(([, label], i) => label.padEnd(widths[i])).join('  '));
  lines.push(headers.map((_, i) => '─'.repeat(widths[i])).join('  '));
  for (const row of rows) {
    lines.push(headers.map(([key], i) => cell(row, key).padEnd(widths[i])).join('  '));
  }
  return lines.join('\n');
}

/**
 * Compose the list rows for cartograph's tabular text mode. The list of
 * cartograph projections comes from the typed API; the title is
 * fetched per-row from the writ row (D9 — N+1). Returns rows in the
 * same order as the input projections (the typed API has already
 * applied the orderBy).
 */
export async function composeListRows<TDoc extends { id: string; stage: string; codex?: string; createdAt: string }>(
  docs: TDoc[],
  clerk: ClerkApi,
): Promise<ListRow[]> {
  const rows: ListRow[] = [];
  for (const doc of docs) {
    let title = '';
    try {
      const writ = await clerk.show(doc.id);
      title = writ.title ?? '';
    } catch {
      // Tolerate orphaned doc rows — render with an empty title rather
      // than aborting the whole list. The typed-API contract keeps writ +
      // doc atomic, so this branch should never fire in practice.
      title = '';
    }
    rows.push({
      stage: doc.stage,
      id: doc.id,
      ...(doc.codex !== undefined ? { codex: doc.codex } : {}),
      title,
      createdAt: doc.createdAt,
    });
  }
  return rows;
}
