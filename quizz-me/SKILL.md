---
name: quizz-me
description: Quiz the user on what the agent just built — testing understanding of changes, decisions, and architecture. Use after the agent completes an implementation task, or when the user says "quizz me", "quiz me", "test my understanding", or similar.
---

<what-to-do>

## Step 1 — Review what you built

Before asking anything, inspect your work. Use the conversation context and re-examine the codebase as needed (git diff, file reads, searches). Identify the significant changes, decisions, and architectural moves worth testing.

## Step 2 — Design the quiz

Size the quiz to the task. Adapt format per topic:
- Multiple choice for factual recall (files changed, APIs, configuration choices)
- Open-ended for reasoning (why a pattern was chosen, trade-offs made)

Cover what matters: structural changes, important decisions, non-obvious choices. Include process questions when the journey was instructive (bugs discovered, approaches tried and rejected).

## Step 3 — Quiz

Ask one question at a time. Wait for a response before continuing.

When the user's answer matches your work, confirm and move on.

When the answer conflicts with your work, treat it as a discussion, not a grading. Your implementation may be wrong. Explain your reasoning, listen to theirs, and revise your work if the user reveals a better approach.

## Step 4 — Offer proactively

After completing an implementation task, offer: "Want me to quiz you on what I just built? Say 'quizz me'."

</what-to-do>

<supporting-info>

## Relationship to grill-me

grill-me stress-tests a plan *before* implementation. quizz-me stress-tests understanding *after* implementation. Symmetrical: grill-me catches gaps in thinking upfront; quizz-me catches gaps in retention after the fact.

## The agent might be wrong

This is not a school exam. The user's answer may reveal a flaw in your implementation. When it does, acknowledge it, discuss, and offer to revise. The quiz is a feedback loop in both directions.

</supporting-info>
