/**
 * Query translation — public WhereClause tuples → InternalQuery.
 *
 * Validates field names against a safe allowlist, then maps the
 * user-facing operator strings to the backend's internal enum.
 */

import type { BookQuery, OrderBy, WhereClause, WhereCondition } from './types.ts';
import type { InternalCondition, InternalQuery } from './backend.ts';

// ── Field name validation ─────────────────────────────────────────────

const SAFE_FIELD_RE = /^[A-Za-z0-9_.-]+$/;

export function validateFieldName(field: string): string {
  if (!SAFE_FIELD_RE.test(field)) {
    throw new Error(`[stacks] Unsafe field name rejected: "${field}"`);
  }
  return field;
}

// ── Condition translation ─────────────────────────────────────────────

function translateCondition(cond: WhereCondition): InternalCondition {
  const field = validateFieldName(cond[0]);
  const op = cond[1];

  switch (op) {
    case '=':        return { field, op: 'eq',  value: cond[2] };
    case '!=':       return { field, op: 'neq', value: cond[2] };
    case '>':        return { field, op: 'gt',  value: cond[2] as number | string };
    case '>=':       return { field, op: 'gte', value: cond[2] as number | string };
    case '<':        return { field, op: 'lt',  value: cond[2] as number | string };
    case '<=':       return { field, op: 'lte', value: cond[2] as number | string };
    case 'LIKE':     return { field, op: 'like', value: cond[2] };
    case 'IN':       return { field, op: 'in', values: cond[2] };
    case 'IS NULL':  return { field, op: 'isNull' };
    case 'IS NOT NULL': return { field, op: 'isNotNull' };
    default:
      throw new Error(`[stacks] Unknown operator: "${op as string}"`);
  }
}

// ── OrderBy normalization ─────────────────────────────────────────────

function normalizeOrderBy(
  orderBy: OrderBy | undefined,
): Array<{ field: string; dir: 'asc' | 'desc' }> | undefined {
  if (!orderBy) return undefined;

  // Single tuple: ['field', 'asc']
  if (typeof orderBy[0] === 'string') {
    const [field, dir] = orderBy as [string, 'asc' | 'desc'];
    return [{ field: validateFieldName(field), dir }];
  }

  // Array of tuples: [['field1', 'asc'], ['field2', 'desc']]
  return (orderBy as Array<[string, 'asc' | 'desc']>).map(([field, dir]) => ({
    field: validateFieldName(field),
    dir,
  }));
}

// ── Public translation ────────────────────────────────────────────────

export function translateQuery(query: BookQuery): InternalQuery {
  // Only called for AND queries — OR queries are handled at the apparatus level
  const where = Array.isArray(query.where) ? query.where : undefined;
  return {
    where: where?.map(translateCondition),
    orderBy: normalizeOrderBy(query.orderBy),
    limit: query.limit,
    offset: query.offset,
  };
}

/**
 * Translate a WhereClause into conditions only (no pagination fields).
 * OR clauses are handled at the apparatus level — this only handles AND.
 */
export function translateWhereClause(
  where?: WhereClause | { or: WhereClause[] },
): { where?: InternalCondition[] } {
  if (!where) return {};
  // Only handles AND clauses — OR is handled at the apparatus level
  if (!Array.isArray(where)) return {};
  if (where.length === 0) return {};
  return { where: where.map(translateCondition) };
}
