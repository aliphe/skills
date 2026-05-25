---
name: grill-with-linear
description: Grilling session that challenges your plan against a Linear project — reading its PRD (project description), milestones, tickets, and documents. Use when the user wants to stress-test a plan against a Linear project definition.
---

<what-to-do>

## Step 1 — Identify the Linear project

If the user hasn't already provided it, ask for the Linear project URL.

Expected format: `https://linear.app/{workspace}/project/{project-slug}/overview`

Parse:
- `{workspace}` — the workspace slug (e.g. `skipr-be`)
- `{project-slug}` — the full slug segment (e.g. `expiring-card-management-productisation-f8255f1421ff`)
- `{slug-id}` — the trailing hex ID in the slug, after the last dash (e.g. `f8255f1421ff`)

## Step 2 — Load the project context

Work through each source in order, collecting everything before asking a single question.

### 2a. Project overview and PRD

The project description is the PRD. Fetch it:

```bash
linear --workspace {workspace} project view {project-slug}
```

If that returns no useful description, fall back to GraphQL to get the full content:

```bash
linear --workspace {workspace} api --variable slugId={slug-id} <<'GRAPHQL'
query($slugId: String!) {
  projects(filter: { slugId: { eq: $slugId } }) {
    nodes {
      id
      name
      description
      state
      startDate
      targetDate
      lead { name }
    }
  }
}
GRAPHQL
```

Store the project `id` (UUID) and `name` — you will need them for subsequent queries.

### 2b. Milestones

```bash
linear --workspace {workspace} milestone list --project {project-id}
```

Note each milestone's name, target date, and description.

### 2c. Issues / Tickets

```bash
linear --workspace {workspace} issue query \
  --project "{project-name}" \
  --all-teams --all-states --limit 0 -j
```

Mentally group issues by milestone and state. Note what is planned, in progress, done, and conspicuously absent.

### 2d. Project documents (Resources)

```bash
linear --workspace {workspace} document list --project {project-slug} --json
```

For each document returned, read its full content:

```bash
linear --workspace {workspace} document view {doc-id} --raw
```

Read all documents before starting the grilling.

## Step 3 — Build a mental model

Before asking a single question, synthesise what you have loaded:

- **PRD**: What problem is this project solving? What are the goals, non-goals, and explicit constraints?
- **Milestones**: What are the major delivery phases? What marks each one complete?
- **Tickets**: What has been scoped? What is conspicuously absent? Where is scope vague or ambiguous?
- **Documents**: What design decisions, architecture notes, or additional requirements already exist?

Identify gaps, contradictions, and underspecified areas — these become your sharpest questions.

## Step 4 — Grill

Interview the user relentlessly about every aspect of their plan until you reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one by one. For each question, provide your recommended answer.

Ask questions one at a time. Wait for feedback before continuing.

If a question can be answered by exploring the codebase or re-reading the Linear content, do that instead of asking.

</what-to-do>

<supporting-info>

## Challenging against the PRD

When the user's plan conflicts with a goal or constraint stated in the project description (PRD), call it out immediately.

"The PRD scopes this to X, but you're describing Y — is this a deliberate scope change or am I misreading the PRD?"

## Challenging against the vocabulary

When the user uses a term that conflicts with language in the PRD or documents, surface it immediately.

"The PRD calls this a 'card programme' but you're saying 'card config' — are these the same thing? If so, which term should we standardise on?"

When the user uses vague or overloaded terms, propose a precise canonical term aligned with the PRD's own vocabulary.

## Challenging against tickets

When the user describes behaviour that already has a ticket, reference it explicitly.

"SKP-123 covers this — is your plan aligned with that issue, or replacing it?"

When the user's plan implies work that has no ticket, flag the gap.

"Nothing in the project covers the migration path for existing cards — is that intentional or a missing ticket?"

## Challenging against milestones

When the user proposes something that belongs to a later milestone, call it out.

"That looks like Milestone 2 scope — are you deliberately pulling it forward, or should we revisit the milestone breakdown?"

## Challenging against documents

When a project document contradicts the plan, surface it.

"The architecture doc says auth tokens are short-lived; you're proposing persistent sessions — which is current?"

## Cross-referencing with code

When the user states how something works, check whether the code agrees. If you find a contradiction, surface it.

"Your code cancels entire card programmes, but you just said partial deactivation is possible — which is right?"

## Discussing concrete scenarios

When domain relationships are being discussed, stress-test them with specific scenarios. Invent scenarios that probe edge cases and force the user to be precise about the boundaries between concepts.

## Writing decisions back

As important decisions crystallise, write them back. Ask the user which format they prefer before writing anything:

**Option A — Linear document attached to the project:**
```bash
cat > /tmp/decision.md <<'EOF'
{content}
EOF
linear --workspace {workspace} document create \
  --project {project-slug} \
  --title "ADR: {short-title}" \
  --content-file /tmp/decision.md
```

**Option B — Local codebase files** (`CONTEXT.md`, `docs/adr/`), using the formats in:
- [../grill-with-docs/CONTEXT-FORMAT.md](../grill-with-docs/CONTEXT-FORMAT.md)
- [../grill-with-docs/ADR-FORMAT.md](../grill-with-docs/ADR-FORMAT.md)

Capture decisions immediately when they crystallise — do not batch them up.

## Updating the glossary inline

When a term is resolved, write it to the glossary right away. `CONTEXT.md` is a glossary only — no implementation details, no spec content, no scratch-pad material.

## Offering ADRs sparingly

Only offer to record a decision (as a Linear document or a local ADR file) when all three are true:

1. **Hard to reverse** — the cost of changing your mind later is meaningful
2. **Surprising without context** — a future reader will wonder "why did they do it this way?"
3. **The result of a real trade-off** — there were genuine alternatives and you picked one for specific reasons

If any of the three is missing, skip it.

</supporting-info>
