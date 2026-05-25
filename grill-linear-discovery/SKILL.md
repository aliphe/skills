---
name: grill-linear-discovery
description: Grilling session that stress-tests a Linear project PRD — challenging goals, success metrics, non-goals, edge cases, constraints, and language precision until the PRD is ready to hand to engineers for scoping. Use in the discovery phase, before any milestones or tickets exist.
---

<what-to-do>

## Step 1 — Identify the Linear project

If the user hasn't already provided it, ask for the Linear project URL.

Expected format: `https://linear.app/{workspace}/project/{project-slug}/overview`

Parse:
- `{workspace}` — the workspace slug (e.g. `skipr-be`)
- `{project-slug}` — the full slug segment (e.g. `expiring-card-management-productisation-f8255f1421ff`)
- `{slug-id}` — the trailing hex ID in the slug, after the last dash (e.g. `f8255f1421ff`)

## Step 2 — Load the PRD context

Work through each source in order, reading everything before asking a single question.

### 2a. Project description (the PRD)

The project description is the PRD. Fetch it:

```bash
linear --workspace {workspace} project view {project-slug}
```

If that returns no useful description, fall back to GraphQL:

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

### 2b. Project documents (Resources)

These often contain research, design specs, user feedback, or earlier versions of the PRD.

```bash
linear --workspace {workspace} document list --project {project-slug} --json
```

Read every document returned:

```bash
linear --workspace {workspace} document view {doc-id} --raw
```

### 2c. Existing tickets (if any)

Even in discovery, some commitments may already have been made. Check for them:

```bash
linear --workspace {workspace} issue query \
  --project "{project-name}" \
  --all-teams --all-states -j
```

Note any tickets that already exist — they constrain what is negotiable.

## Step 3 — Diagnose the PRD before asking anything

Read the full PRD and documents, then build a diagnostic picture across these dimensions. Do not ask questions yet — form your view first.

| Dimension | What to look for |
|---|---|
| **Problem framing** | Is the current state defined? Is the pain quantified? Is it clear who suffers from it? |
| **Goals** | Are they specific and measurable? Could you write a test that proves a goal was met? |
| **Non-goals** | Are they explicit? Without them, every edge case becomes in-scope by default. |
| **Scope completeness** | Are all user journeys represented? What happens in the error/edge paths? |
| **Constraints** | Technical, regulatory, timeline, team? Are they stated or assumed? |
| **Dependencies** | Other teams, external services, internal systems — are they named? |
| **Assumptions** | What is being taken for granted that could turn out to be false? |
| **Risks** | What could go wrong and isn't mentioned? |
| **Language** | Are the same concepts called by the same name throughout? Are any terms ambiguous? |
| **Testability** | Can you tell when each requirement is fully met? |

Identify the three to five most critical weaknesses. Start the grilling there.

## Step 4 — Grill

Your goal is a PRD that a senior engineer could read and immediately begin scoping — no ambiguities to resolve, no silent assumptions to discover mid-delivery, no debates about what's in or out of scope.

Interview the user relentlessly, walking through each weakness you identified. For each question:
- Provide your recommended answer
- Explain why the current wording is insufficient
- Propose the precise language that should replace it

Ask one question at a time. Wait for a response before continuing.

## Step 5 — Produce the refined PRD

Once the session converges, write a clean revised PRD that incorporates every resolution from the session. Ask the user whether to:

**Option A — Update the Linear project description directly:**
```bash
linear --workspace {workspace} project update {project-slug} \
  --description "$(cat /tmp/prd-revised.md)"
```

**Option B — Create a versioned document attached to the project:**
```bash
linear --workspace {workspace} document create \
  --project {project-slug} \
  --title "PRD (refined)" \
  --content-file /tmp/prd-revised.md
```

</what-to-do>

<supporting-info>

## What a grill-ready PRD looks like

A PRD is ready for engineering scoping when a senior engineer can read it and confidently answer:
- What problem are we solving, and for whom?
- How will we know we've solved it?
- What are we explicitly not doing?
- What are the hard constraints we cannot break?
- What could go wrong, and what's the plan?

If any of those questions require a follow-up conversation, the PRD isn't ready.

## Challenging vague goals

"Improve the card management experience" is not a goal — it is a wish. Push until the goal is measurable.

"You've written 'improve card renewal UX' — what does success look like in numbers? Completion rate? Drop-off reduction? Time-to-renewal? Propose a specific metric and threshold."

## Challenging missing non-goals

Non-goals are as important as goals. Without them, every edge case becomes in-scope by default and engineers will debate scope mid-delivery.

"The PRD never says what's out of scope. If a user has three cards expiring at once, is multi-card batch renewal in scope? If it isn't, say so explicitly."

## Challenging fuzzy scope

When a user journey isn't described end-to-end, press on the gaps.

"You've described the happy path — card renewal initiated, user notified. What happens when the renewal fails? What happens when the user ignores all notifications and the card expires anyway? Both paths need explicit handling decisions."

## Challenging unstated assumptions

Flush out assumptions before they become surprises.

"You mention real-time expiry detection, but the current card provider API is polled daily. Are you assuming that changes, or designing within the current constraint? If the former, that's a dependency that needs to be stated."

## Challenging unmeasurable constraints

"Compliant with regulations" is not a constraint. Name the regulation. Name the specific article.

"'GDPR compliant' — which specific obligations does this feature trigger? Right to erasure? Data minimisation? Name them or engineers won't know what to implement."

## Sharpening language

When the same concept appears under different names, it will spawn confusion across tickets, code, and conversations.

"You use 'card programme', 'card config', and 'card product' in the same document. Are these the same thing? Pick one term and use it consistently throughout."

## Discussing concrete scenarios

For every domain rule stated in the PRD, invent a scenario that probes its boundary.

"You say cards are flagged 30 days before expiry. What about a card issued today with an expiry date 15 days away? Does it get flagged immediately? If so, does the '30-day window' rule need rewording?"

## What the grilling is NOT for

- Proposing implementation approaches — that is the delivery phase
- Designing the data model or APIs — that is the delivery phase
- Assigning work to people — that is the delivery phase

Stay in the problem space. The PRD defines what and why, not how.

</supporting-info>
