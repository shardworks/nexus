/**
 * Built-in block type: book-updated.
 *
 * Blocks until a specific book (or document within it) has content.
 * Condition: { ownerId: string; book: string; documentId?: string }
 *
 * When documentId is provided: checks if that specific document exists.
 * When documentId is absent: checks if any document exists in the book.
 */

import { z } from 'zod';
import { guild } from '@shardworks/nexus-core';
import type { StacksApi } from '@shardworks/stacks-apparatus';
import type { BlockType } from '../types.ts';

const conditionSchema = z.object({
  ownerId: z.string(),
  book: z.string(),
  documentId: z.string().optional(),
});

const bookUpdatedBlockType: BlockType = {
  id: 'book-updated',
  conditionSchema,
  pollIntervalMs: 10_000,
  async check(condition: unknown): Promise<boolean> {
    const { ownerId, book, documentId } = conditionSchema.parse(condition);
    const stacks = guild().apparatus<StacksApi>('stacks');
    const targetBook = stacks.readBook<Record<string, unknown>>(ownerId, book);
    if (documentId) {
      // Per-document: check if the document exists
      const doc = await targetBook.get(documentId);
      return doc !== null && doc !== undefined;
    }
    // Per-book: check if any documents exist
    const docs = await targetBook.find({ limit: 1 });
    return docs.length > 0;
  },
};

export default bookUpdatedBlockType;
