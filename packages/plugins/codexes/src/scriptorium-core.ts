/**
 * The Scriptorium — core logic.
 *
 * Manages the codex registry (bare clones), draft binding lifecycle
 * (worktrees), and sealing (ff-only merge or rebase+ff). All git
 * operations go through the git helper for safety.
 *
 * Draft tracking is in-memory — drafts are reconstructed from
 * filesystem state at startup and maintained in memory during the
 * process lifetime.
 *
 * See: docs/architecture/apparatus/scriptorium.md
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { guild } from '@shardworks/nexus-core';

import { git, resolveDefaultBranch, resolveRef, commitsAhead, GitError } from './git.ts';

import type {
  CodexRecord,
  CodexDetail,
  DraftRecord,
  OpenDraftRequest,
  AbandonDraftRequest,
  SealRequest,
  SealResult,
  PushRequest,
  CodexesConfig,
  CodexConfigEntry,
  ScriptoriumApi,
} from './types.ts';

// ── Internal state ──────────────────────────────────────────────────

interface CodexState {
  name: string
  remoteUrl: string
  cloneStatus: 'ready' | 'cloning' | 'error'
  lastFetched: string | null
  /** Promise that resolves when the bare clone is ready (for background clones). */
  clonePromise?: Promise<void>
}

// ── ULID-like ID generation ─────────────────────────────────────────

function generateDraftId(): string {
  // Timestamp prefix (ms, base36) + random suffix for uniqueness.
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(4).toString('hex');
  return `${ts}${rand}`;
}

// ── Core class ──────────────────────────────────────────────────────

export class ScriptoriumCore {
  private codexes = new Map<string, CodexState>();
  private drafts = new Map<string, DraftRecord>(); // keyed by `${codexName}/${branch}`

  private maxMergeRetries: number = 3;
  private draftRoot: string = '.nexus/worktrees';

  // ── Paths ───────────────────────────────────────────────────────

  private get home(): string {
    return guild().home;
  }

  private codexesDir(): string {
    return path.join(this.home, '.nexus', 'codexes');
  }

  private bareClonePath(name: string): string {
    return path.join(this.codexesDir(), `${name}.git`);
  }

  private draftWorktreePath(codexName: string, branch: string): string {
    return path.join(this.home, this.draftRoot, codexName, branch);
  }

  // ── Startup ─────────────────────────────────────────────────────

  start(): void {
    const config = guild().config<CodexesConfig>('codexes');

    // Apply settings
    this.maxMergeRetries = config.settings?.maxMergeRetries ?? 3;
    this.draftRoot = config.settings?.draftRoot ?? '.nexus/worktrees';

    // Ensure infrastructure directories exist
    fs.mkdirSync(this.codexesDir(), { recursive: true });

    // Load registered codexes from config
    const registered = config.registered ?? {};
    for (const [name, entry] of Object.entries(registered)) {
      this.loadCodex(name, entry);
    }

    // Reconcile drafts from filesystem
    this.reconcileDrafts();
  }

  /**
   * Load a codex from config. Checks for existing bare clone;
   * initiates background clone if missing.
   */
  private loadCodex(name: string, entry: CodexConfigEntry): void {
    const clonePath = this.bareClonePath(name);
    const exists = fs.existsSync(clonePath);

    const state: CodexState = {
      name,
      remoteUrl: entry.remoteUrl,
      cloneStatus: exists ? 'ready' : 'cloning',
      lastFetched: null,
    };

    if (!exists) {
      // Background clone — doesn't block startup
      state.clonePromise = this.performClone(name, entry.remoteUrl)
        .then(() => { state.cloneStatus = 'ready'; })
        .catch((err) => {
          state.cloneStatus = 'error';
          console.warn(`[scriptorium] Background clone of "${name}" failed: ${err instanceof Error ? err.message : err}`);
        });
    }

    this.codexes.set(name, state);
  }

  /**
   * Reconcile in-memory draft tracking with filesystem state.
   * Scans the worktree directories and rebuilds the draft map.
   */
  private reconcileDrafts(): void {
    const worktreeRoot = path.join(this.home, this.draftRoot);
    if (!fs.existsSync(worktreeRoot)) return;

    for (const codexDir of fs.readdirSync(worktreeRoot, { withFileTypes: true })) {
      if (!codexDir.isDirectory()) continue;
      const codexName = codexDir.name;

      // Only reconcile drafts for known codexes
      if (!this.codexes.has(codexName)) continue;

      const codexWorktreeDir = path.join(worktreeRoot, codexName);
      for (const draftDir of fs.readdirSync(codexWorktreeDir, { withFileTypes: true })) {
        if (!draftDir.isDirectory()) continue;
        const branch = draftDir.name;
        const draftPath = path.join(codexWorktreeDir, branch);

        // Verify it's actually a git worktree (has .git file)
        if (!fs.existsSync(path.join(draftPath, '.git'))) continue;

        const key = `${codexName}/${branch}`;
        if (!this.drafts.has(key)) {
          this.drafts.set(key, {
            id: generateDraftId(),
            codexName,
            branch,
            path: draftPath,
            createdAt: new Date().toISOString(), // approximate — we don't know the real time
          });
        }
      }
    }
  }

  // ── Clone readiness ─────────────────────────────────────────────

  /**
   * Ensure a codex's bare clone is ready. Blocks if a background
   * clone is in progress. Throws if the codex is unknown or clone failed.
   */
  private async ensureReady(name: string): Promise<CodexState> {
    const state = this.codexes.get(name);
    if (!state) {
      throw new Error(`Codex "${name}" is not registered. Use codex-add to register it.`);
    }

    if (state.clonePromise) {
      await state.clonePromise;
      state.clonePromise = undefined;
    }

    if (state.cloneStatus === 'error') {
      throw new Error(
        `Codex "${name}" bare clone failed. Remove and re-add the codex, or check the remote URL.`,
      );
    }

    return state;
  }

  // ── Git operations ──────────────────────────────────────────────

  private async performClone(name: string, remoteUrl: string): Promise<void> {
    const clonePath = this.bareClonePath(name);
    fs.mkdirSync(path.dirname(clonePath), { recursive: true });
    await git(['clone', '--bare', remoteUrl, clonePath]);
  }

  private async performFetch(name: string): Promise<void> {
    const clonePath = this.bareClonePath(name);
    await git(['fetch', '--prune', 'origin'], clonePath);

    const state = this.codexes.get(name);
    if (state) {
      state.lastFetched = new Date().toISOString();
    }
  }

  // ── API Implementation ────────────────────────────────────────

  createApi(): ScriptoriumApi {
    return {
      add: (name, remoteUrl) => this.add(name, remoteUrl),
      list: () => this.list(),
      show: (name) => this.show(name),
      remove: (name) => this.remove(name),
      fetch: (name) => this.fetchCodex(name),
      push: (request) => this.push(request),
      openDraft: (request) => this.openDraft(request),
      listDrafts: (codexName?) => this.listDrafts(codexName),
      abandonDraft: (request) => this.abandonDraft(request),
      seal: (request) => this.seal(request),
    };
  }

  // ── Codex Registry ──────────────────────────────────────────────

  async add(name: string, remoteUrl: string): Promise<CodexRecord> {
    if (this.codexes.has(name)) {
      throw new Error(`Codex "${name}" is already registered.`);
    }

    // Clone bare repo (blocking)
    const state: CodexState = {
      name,
      remoteUrl,
      cloneStatus: 'cloning',
      lastFetched: null,
    };
    this.codexes.set(name, state);

    try {
      await this.performClone(name, remoteUrl);
      state.cloneStatus = 'ready';
    } catch (err) {
      state.cloneStatus = 'error';
      this.codexes.delete(name);
      throw new Error(
        `Failed to clone "${remoteUrl}" for codex "${name}": ${err instanceof Error ? err.message : err}`,
      );
    }

    // Persist to guild.json
    const config = guild().config<CodexesConfig>('codexes');
    const registered = config.registered ?? {};
    registered[name] = { remoteUrl };
    guild().writeConfig('codexes', { ...config, registered });

    return this.toCodexRecord(state);
  }

  async list(): Promise<CodexRecord[]> {
    const records: CodexRecord[] = [];
    for (const state of this.codexes.values()) {
      records.push(this.toCodexRecord(state));
    }
    return records;
  }

  async show(name: string): Promise<CodexDetail> {
    const state = await this.ensureReady(name);
    const clonePath = this.bareClonePath(name);
    const defaultBranch = await resolveDefaultBranch(clonePath);
    const drafts = this.draftsForCodex(name);

    return {
      name: state.name,
      remoteUrl: state.remoteUrl,
      cloneStatus: state.cloneStatus,
      activeDrafts: drafts.length,
      defaultBranch,
      lastFetched: state.lastFetched,
      drafts,
    };
  }

  async remove(name: string): Promise<void> {
    const state = this.codexes.get(name);
    if (!state) {
      throw new Error(`Codex "${name}" is not registered.`);
    }

    // Abandon all drafts for this codex
    const drafts = this.draftsForCodex(name);
    for (const draft of drafts) {
      await this.abandonDraft({ codexName: name, branch: draft.branch, force: true });
    }

    // Remove bare clone
    const clonePath = this.bareClonePath(name);
    if (fs.existsSync(clonePath)) {
      fs.rmSync(clonePath, { recursive: true, force: true });
    }

    // Remove from in-memory state
    this.codexes.delete(name);

    // Remove from guild.json
    const config = guild().config<CodexesConfig>('codexes');
    const registered = { ...(config.registered ?? {}) };
    delete registered[name];
    guild().writeConfig('codexes', { ...config, registered });
  }

  async fetchCodex(name: string): Promise<void> {
    await this.ensureReady(name);
    await this.performFetch(name);
  }

  async push(request: PushRequest): Promise<void> {
    const state = await this.ensureReady(request.codexName);
    const clonePath = this.bareClonePath(state.name);
    const branch = request.branch ?? await resolveDefaultBranch(clonePath);

    await git(['push', 'origin', branch], clonePath);
  }

  // ── Draft Binding Lifecycle ─────────────────────────────────────

  async openDraft(request: OpenDraftRequest): Promise<DraftRecord> {
    const state = await this.ensureReady(request.codexName);
    const clonePath = this.bareClonePath(state.name);

    // Fetch before branching for freshness
    await this.performFetch(state.name);

    const branch = request.branch ?? `draft-${generateDraftId()}`;
    const key = `${request.codexName}/${branch}`;

    // Reject if draft already exists
    if (this.drafts.has(key)) {
      throw new Error(
        `Draft with branch "${branch}" already exists for codex "${request.codexName}". ` +
        `Choose a different branch name or abandon the existing draft.`,
      );
    }

    const defaultBranch = await resolveDefaultBranch(clonePath);
    // In a bare clone, refs are at refs/heads/* (mirroring the remote),
    // not refs/remotes/origin/*. Use the branch name directly since we
    // already fetched to ensure freshness.
    const startPoint = request.startPoint ?? defaultBranch;

    const worktreePath = this.draftWorktreePath(request.codexName, branch);
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });

    // Create worktree with new branch from start point
    await git(
      ['worktree', 'add', worktreePath, '-b', branch, startPoint],
      clonePath,
    );

    const draft: DraftRecord = {
      id: generateDraftId(),
      codexName: request.codexName,
      branch,
      path: worktreePath,
      createdAt: new Date().toISOString(),
      associatedWith: request.associatedWith,
    };

    this.drafts.set(key, draft);
    return draft;
  }

  async listDrafts(codexName?: string): Promise<DraftRecord[]> {
    if (codexName) {
      return this.draftsForCodex(codexName);
    }
    return [...this.drafts.values()];
  }

  async abandonDraft(request: AbandonDraftRequest): Promise<void> {
    const key = `${request.codexName}/${request.branch}`;
    const draft = this.drafts.get(key);

    if (!draft) {
      throw new Error(
        `No active draft with branch "${request.branch}" for codex "${request.codexName}".`,
      );
    }

    // Check for unsealed inscriptions (commits ahead of the sealed binding)
    if (!request.force) {
      const state = await this.ensureReady(request.codexName);
      const clonePath = this.bareClonePath(state.name);

      try {
        const defaultBranch = await resolveDefaultBranch(clonePath);
        const ahead = await commitsAhead(clonePath, request.branch, defaultBranch);

        if (ahead > 0) {
          throw new Error(
            `Draft "${request.branch}" has ${ahead} unsealed inscription(s). ` +
            `Use force: true to abandon anyway, or seal the draft first.`,
          );
        }
      } catch (err) {
        // If the branch doesn't exist in the bare clone (already cleaned up),
        // that's fine — proceed with cleanup
        if (err instanceof GitError && err.stderr.includes('unknown revision')) {
          // Branch already gone — proceed with cleanup
        } else if (err instanceof Error && err.message.includes('unsealed inscription')) {
          throw err;
        }
        // Other git errors during the check are non-fatal — proceed with cleanup
      }
    }

    // Remove worktree
    const clonePath = this.bareClonePath(request.codexName);
    try {
      await git(['worktree', 'remove', '--force', draft.path], clonePath);
    } catch {
      // If worktree removal fails (e.g. already gone), try manual cleanup
      if (fs.existsSync(draft.path)) {
        fs.rmSync(draft.path, { recursive: true, force: true });
      }
      // Prune stale worktree references
      try {
        await git(['worktree', 'prune'], clonePath);
      } catch { /* best effort */ }
    }

    // Delete the branch from the bare clone
    try {
      await git(['branch', '-D', request.branch], clonePath);
    } catch {
      // Branch may already be gone — that's fine
    }

    // Remove from in-memory tracking
    this.drafts.delete(key);
  }

  async seal(request: SealRequest): Promise<SealResult> {
    const state = await this.ensureReady(request.codexName);
    const clonePath = this.bareClonePath(state.name);
    const maxRetries = request.maxRetries ?? this.maxMergeRetries;

    const defaultBranch = await resolveDefaultBranch(clonePath);
    const targetBranch = request.targetBranch ?? defaultBranch;

    let strategy: 'fast-forward' | 'rebase' = 'fast-forward';
    let retries = 0;

    // Fetch before sealing for freshness
    await this.performFetch(state.name);

    // Attempt ff-only merge, with rebase retry loop
    while (retries <= maxRetries) {
      try {
        // Try fast-forward merge: update the target branch ref to point at the source
        // In a bare repo, we use `git merge --ff-only` with the branch checked out,
        // but bare repos don't have a checkout. Instead, we verify ancestry and
        // update the ref directly.
        const targetRef = await resolveRef(clonePath, targetBranch);
        const sourceRef = await resolveRef(clonePath, request.sourceBranch);

        // Check if source is already at target (nothing to seal)
        if (targetRef === sourceRef) {
          // Clean up draft unless keepDraft
          if (!request.keepDraft) {
            await this.abandonDraft({
              codexName: request.codexName,
              branch: request.sourceBranch,
              force: true,
            });
          }
          return { success: true, strategy, retries, sealedCommit: targetRef };
        }

        // Check if target is an ancestor of source (ff is possible)
        const { stdout: mergeBase } = await git(
          ['merge-base', targetBranch, request.sourceBranch],
          clonePath,
        );

        if (mergeBase === targetRef) {
          // Fast-forward is possible — update the ref
          await git(
            ['update-ref', `refs/heads/${targetBranch}`, sourceRef],
            clonePath,
          );

          // Clean up draft unless keepDraft
          if (!request.keepDraft) {
            await this.abandonDraft({
              codexName: request.codexName,
              branch: request.sourceBranch,
              force: true,
            });
          }

          return { success: true, strategy, retries, sealedCommit: sourceRef };
        }

        // FF not possible — rebase the source branch onto the target
        strategy = 'rebase';

        // Rebase needs a worktree (can't rebase in a bare repo).
        // Use the draft's existing worktree.
        const key = `${request.codexName}/${request.sourceBranch}`;
        const draft = this.drafts.get(key);
        if (!draft) {
          throw new Error(
            `Cannot rebase: no active draft for branch "${request.sourceBranch}". ` +
            `The draft worktree is needed for rebase operations.`,
          );
        }

        try {
          await git(['rebase', targetBranch], draft.path);
        } catch (err) {
          // Rebase conflict — abort and fail
          try {
            await git(['rebase', '--abort'], draft.path);
          } catch { /* best effort */ }

          throw new Error(
            `Sealing seized: rebase of "${request.sourceBranch}" onto "${targetBranch}" ` +
            `produced conflicts. Manual reconciliation is needed.`,
          );
        }

        // Rebase succeeded — re-fetch and retry the ff merge
        retries++;
        await this.performFetch(state.name);
        continue;
      } catch (err) {
        if (err instanceof Error && err.message.includes('Sealing seized')) {
          throw err;
        }
        if (err instanceof Error && err.message.includes('Cannot rebase')) {
          throw err;
        }
        // Unexpected error — don't retry
        throw err;
      }
    }

    throw new Error(
      `Sealing failed after ${maxRetries} retries. Codex "${request.codexName}", ` +
      `branch "${request.sourceBranch}" → "${targetBranch}".`,
    );
  }

  // ── Helpers ───────────────────────────────────────────────────────

  private draftsForCodex(codexName: string): DraftRecord[] {
    return [...this.drafts.values()].filter((d) => d.codexName === codexName);
  }

  private toCodexRecord(state: CodexState): CodexRecord {
    return {
      name: state.name,
      remoteUrl: state.remoteUrl,
      cloneStatus: state.cloneStatus,
      activeDrafts: this.draftsForCodex(state.name).length,
    };
  }
}
