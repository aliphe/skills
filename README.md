# Skills

A personal library of [Agent Skills](https://agentskills.io/specification) compatible with **pi**, **opencode**, and any other harness that follows the standard.

## Structure

```
skills/
├── README.md
├── link.sh            # Sets up symlinks into agent skill directories
└── <skill-name>/
    ├── SKILL.md       # Required: frontmatter + instructions
    └── ...            # Scripts, references, assets
```

Each skill lives in its own directory with a `SKILL.md` at its root.

## Setup

Run once (and re-run when new skills are added):

```bash
./link.sh
```

This creates:
- `~/.agents/skills/personal-skills → <this repo>` — pi discovers all skills recursively
- `~/.config/opencode/skills/<skill-name> → <this repo>/<skill-name>` — one symlink per skill for opencode

## Adding a Skill

1. Create `<skill-name>/SKILL.md` with valid frontmatter (`name`, `description`)
2. Add any supporting scripts or references alongside it
3. Re-run `./link.sh` to register the new skill with opencode (pi picks it up automatically)
