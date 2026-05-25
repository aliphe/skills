---
name: grill-linear-delivery
description: Grilling session that challenges a technical delivery plan (milestones + tickets) against the project PRD — finding coverage gaps, scope creep, missing non-functional work, and unrealistic phasing. Use after discovery, once engineers have proposed their breakdown.
---

<what-to-do>

## Step 1 — Identify the Linear project

If the user hasn't already provided it, ask for the Linear project URL.

Expected format: `https://linear.app/{workspace}/project/{project-slug}/overview`

Parse:
- `{workspace}` — the workspace slug (e.g. `skipr-be`)
- `{project-slug}` — the full slug segment (e.g. `expiring-card-management-productisation-f8255f1421ff`)
- `{slug-id}` — the trailing hex ID in the slug, after the last dash (e.g. `f8255f1421ff`)

## Step 2 — Load the full project context

Read everything before asking a single question. Work through each source in order.

### 2a. Project description (the PRD — source of truth)

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

These may contain architecture decisions, design specs, or additional requirements.

```bash
linear --workspace {workspace} document list --project {project-slug} --json
```

Read every document returned:

```bash
linear --workspace {workspace} document view {doc-id} --raw
```

### 2c. Milestones

```bash
linear --workspace {workspace} milestone list --project {project-id}
```

Note each milestone's name, description, and target date.

### 2d. All tickets

```bash
linear --workspace {workspace} issue query \
  --project "{project-name}" \
  --all-teams --all-states --limit 0 -j
```

Group issues by milestone mentally. For each issue note the title, state, estimate (if any), and any milestone assignment.

## Step 3 — Build the coverage map

Before asking anything, do this analysis:

### Map PRD requirements → tickets

Read every requirement, user story, goal, and constraint in the PRD. For each one, find the ticket(s) that deliver it. Flag any requirement with no matching ticket as a **gap**.

### Map tickets → PRD requirements

Read every ticket. For each one, identify which PRD requirement it serves. Flag any ticket with no clear PRD anchor as **potential scope creep** (may be valid tech debt, but needs to be explicit).

### Check non-functional requirements

These are routinely underspecified in tickets. Scan for coverage of:
- Error handling and failure modes
- Observability (logging, metrics, alerting)
- Security and auth
- Performance requirements from the PRD
- Data migrations (for existing records)
- Rollback / feature-flag strategy
- Documentation (internal and external)

### Check milestone health

For each milestone, assess:
- Can it be demoed or shipped independently?
- Is its completion criterion clear?
- Does its scope feel realistic against the target date?
- Does it respect the ordering of the one before it?

### Prioritise findings

Rank your findings by severity: blockers (PRD requirement with zero coverage), major concerns (missing non-functional work, milestone ordering issues), minor concerns (unclear ticket scope, missing estimates).

## Step 4 — Grill

Walk through your findings starting with the most critical. For each finding:
- State the gap or concern precisely
- Reference the specific PRD section and the specific ticket (or absence of one)
- Propose a resolution — a new ticket, a milestone adjustment, a scope clarification

Ask one question at a time. Wait for a response before continuing.

If a question can be answered by reading the codebase (e.g. "does the existing schema support this?"), do that instead of asking.

## Step 5 — Produce the gap analysis

Once the session converges, offer to materialise the findings:

**Option A — Create gap tickets directly:**
```bash
# For each gap identified, create a ticket
cat > /tmp/ticket.md <<'EOF'
{ticket description}
EOF
linear --workspace {workspace} issue create \
  --project "{project-name}" \
  --title "{gap title}" \
  --description-file /tmp/ticket.md \
  --milestone "{relevant milestone}"
```

**Option B — Create a gap analysis document attached to the project:**
```bash
cat > /tmp/gap-analysis.md <<'EOF'
{gap analysis content}
EOF
linear --workspace {workspace} document create \
  --project {project-slug} \
  --title "Delivery gap analysis" \
  --content-file /tmp/gap-analysis.md
```

Do not create tickets or documents without the user's confirmation on each one.

</what-to-do>

<supporting-info>

## The job of this grilling session

The PRD says what must be true when the project is done. The delivery plan says how we'll get there. This session closes the gap between them.

A delivery plan passes this grilling when:
- Every PRD requirement is covered by at least one ticket
- Every milestone can be demo'd or shipped independently
- The non-functional requirements (observability, error handling, migrations) are ticketed
- No ticket exists purely by engineering inertia with no PRD anchor
- The phasing is logical and the timeline is honest

## Challenging coverage gaps

When a PRD requirement has no ticket, name it and propose what the ticket should say.

"The PRD requires that card-holders are notified 30 days before expiry by both email and push. I see no notification ticket in any milestone. This is a full integration point — where does it live?"

"The PRD calls out GDPR right-to-erasure implications for stored card metadata. No ticket addresses this. It needs one, probably in Milestone 1 since it affects the data model."

## Challenging scope creep

When a ticket has no clear PRD anchor, call it out — not to kill it, but to be explicit about what it is.

"SKP-89 refactors the card-provider adapter layer. The PRD doesn't mention this. Is this tech debt being bundled in? If so, it should be labelled as such and the milestone scope should account for it."

## Challenging non-functional omissions

Non-functional requirements are almost always under-ticketed. Be systematic.

"There are 12 tickets for card lifecycle logic but none for observability. When a renewal silently fails at 2am, how will you know? Where's the alerting ticket?"

"The PRD mentions a migration of existing card records to the new schema. I don't see a migration ticket. Data migrations are often the riskiest part of delivery — they need their own ticket, their own test plan, and a rollback story."

## Challenging milestone independence

Each milestone should be shippable on its own — not necessarily to end-users, but to a staging environment and demonstrable to stakeholders.

"Milestone 1 ends with 'backend complete'. Milestone 2 begins 'frontend integration'. If Milestone 1 slips, Milestone 2 is blocked entirely. Is there a way to parallelise, or should the milestone boundary be redrawn?"

"What is the demo story for Milestone 1? If you had to show a stakeholder what was delivered, what would you show? If the answer is 'nothing visible', the milestone boundary is in the wrong place."

## Challenging timeline realism

"Milestone 2 has 14 tickets, three of which involve external provider integrations, and a target date of 3 weeks. That's aggressive. Which tickets are hard blockers for the milestone and which could slip to Milestone 3 without consequence?"

## Challenging consistency with the PRD

When a ticket description contradicts a PRD requirement, surface the contradiction.

"SKP-101 says renewal notifications will be sent 14 days before expiry. The PRD says 30 days. Which is correct? If the spec changed, the PRD needs updating."

## Distinguishing must-have from nice-to-have

Use the PRD's goals to force prioritisation. Every ticket should map to a goal. If it maps to no goal, it's a candidate for the backlog.

"The PRD has one goal: ensure no card lapses without the user being aware and given a renewal path. Does SKP-77 (redesign of the card detail page) directly serve that goal, or is it bundled opportunism?"

## Cross-referencing with code

When a ticket assumes a capability that may not exist, check the codebase.

"SKP-95 assumes the existing notification service supports push notifications. Does it? If not, that's a dependency that needs its own ticket."

</supporting-info>
