# Nexus Mk 2.1 — Project Philosophy

## What Is This

Nexus Mk 2.1 is an experimental multi-agent AI system — and a deliberate departure from its predecessor.

In Mk 2.0, the human was an architect-reviewer: reading code, approving pull requests, steering implementation. The codebase was shared territory. In Mk 2.1, the human is a *user*. The system produces things; the human uses them. The internal workings are the system's own business.

The project serves multiple purposes simultaneously:

1. **Build an autonomous system** — A system where AI agents collaborate to accomplish objectives, delivering usable artifacts without human involvement in implementation.
2. **Explore the user boundary** — Discover what happens when the human gives up visibility into internals and evaluates the system purely by its outputs.
3. **Document the experiment** — The process of building and interacting with the system is primary source material for published writing on AI-enabled development.

## Precepts

1. **The system will be known by its fruits.** The human judges the system by using what it produces, not by inspecting how it was made. Quality is measured at the boundary.

2. **If you can't touch it, it doesn't exist.** The system's job isn't done at the commit. It's done when a human can run, use, or interact with what was built.

3. **Point at the mountain, not the trail.** The human names the destination. The system finds its own path. How it gets there is not the human's concern.

4. **The sanctum is sacred ground.** This repo is the human's space — for thinking, tooling, and orchestration. The system's code lives elsewhere. Agents do not operate here autonomously. You *could* cross the boundary; the system should never require it.

## Mantras

Personal reminders for the human operator. Not system rules — habits of mind.

- **Let go of the wheel.** Resist the urge to steer implementation. Direct, then trust. The hardest part isn't building the system; it's not reaching in to fix it yourself.
- **Speak in wishes, not blueprints.** Express what you want, not how to build it. The more you specify, the less the system can surprise you — and surprise is the point.

## Tech Stack

- **Language:** TypeScript
- **Runtime:** Node.js (v24)

## Topology

This repository (`nexus-mk2`) is the sanctum — the human's space for thinking, planning, and building tools to direct and evaluate the system. Agent configurations, session transcripts, evaluation scripts, and orchestration tooling live here.

The system's own code lives in separate repositories within the same organization. The human does not clone, review, or contribute to those repositories during normal operation. The boundary is maintained by discipline, not access control.

## Agent Architecture

Agents are defined in `.claude/agents/`. Each agent file specifies a persona with its own responsibilities and interaction style. All agents inherit the shared directives in `.claude/CLAUDE.md`.

- **Interactive agents** engage in conversation with the human. Sessions are captured as transcripts. (e.g., Coco)
- **Autonomous agents** are invoked programmatically, run without human interaction, and exit when their task is complete.

## Addendums

### On Mountains and Trails

A destination is not just a peak — it is a peak with constraints. Some constraints describe how to get there and belong to the system. Others describe properties the output must have to be usable at all. These are requirements, and they belong in the direction.

The test is simple: **if the system built it another way and you would accept it, let it go.** If building it another way would make the output unusable to you, name it. Name what usability requires. The system owns everything else.

### On Building Trust

The system does not begin capable. There is a period before the user relationship is possible — when the system is building its own foundation and the human cannot yet evaluate the infrastructure purely by its outputs.

Initially, the human names more requirements. The same test applies — name what usability requires — but more things are required because the foundation is unproven. Architecture, data boundaries, workflow design: these are properties the output must have to be usable, and the human names them until the infrastructure earns the right to own them.
