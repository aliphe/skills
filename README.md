# Skills

A personal library of [Agent Skills](https://agentskills.io/specification) compatible with **pi**, **opencode**, **Claude Code**, **Codex**, **Cursor**, and more.

## Install

Use [vercel-labs/skills](https://github.com/vercel-labs/skills) to install skills from this repo into your agent harnesses:

```bash
# Interactive — pick skills and agents
npx skills add aliphe/skills

# Install all skills globally
npx skills add aliphe/skills --all -g

# Install a specific skill globally
npx skills add aliphe/skills --skill linear-cli -g

# Install to specific agents
npx skills add aliphe/skills -a pi -a opencode -g
```

`-g` installs to your user directory (`~/<agent>/skills/`) so the skills are available across all projects. Omit it to install into the current project instead.

## Structure

```
skills/
├── README.md
└── <skill-name>/
    ├── SKILL.md       # Required: frontmatter + instructions
    └── ...            # Scripts, references, assets
```

Each skill lives in its own directory with a `SKILL.md` at its root.

## Adding a Skill

1. Create `<skill-name>/SKILL.md` with valid frontmatter (`name`, `description`)
2. Add any supporting scripts or references alongside it
3. Commit and push — consumers can re-run `npx skills add aliphe/skills` to pick up the new skill
