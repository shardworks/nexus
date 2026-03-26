# commission-create

Post a commission to the guild. The Clockworks handles everything downstream — worktree setup, anima summoning, and post-session merge.

## Usage

```
commission-create <spec> --workshop <workshop>
```

## Arguments

- `<spec>` — Commission specification describing what needs to be done. Include a clear problem statement and acceptance criteria.
- `--workshop <workshop>` — Target workshop where the work will be done.

## Guidance

- Write clear, specific commission specs. The artificer receives this as their entire brief.
- Include acceptance criteria so the artificer knows when the work is done.
- After posting, use `nsg clock run` to process the commission through the Clockworks pipeline.
- The commission flows through standing orders: workshop-prepare → summon artificer → workshop-merge.
