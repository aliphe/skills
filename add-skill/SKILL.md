---
name: add-skill
description: Add a new skill from a GitHub URL to this personal skills repo, register it with agent harnesses, then commit and push. Use when the user provides a GitHub URL for a skill they want to install.
---

# Add Skill

Adds a skill from a GitHub URL to `/Users/matthias/work/perso/skills`, registers it via `link.sh`, commits, and pushes.

## Supported URL Formats

| Format | Example |
|--------|---------|
| Full repo (repo root = skill) | `https://github.com/owner/repo` |
| Subdirectory of a repo | `https://github.com/owner/repo/tree/BRANCH/path/to/skill` |

## Steps

### 1. Parse the URL

Determine the clone target:

- **No `/tree/` segment** → entire repo is the skill.
  - Clone URL: `https://github.com/OWNER/REPO`
  - Skill path inside clone: `.` (root)
  - Default skill directory name: `REPO`

- **Has `/tree/BRANCH/PATH`** → skill lives in a subdirectory.
  - Clone URL: `https://github.com/OWNER/REPO`
  - Branch: extracted from URL
  - Skill path inside clone: `PATH`
  - Default skill directory name: last segment of `PATH`

### 2. Clone (sparse when subdirectory)

**Full repo:**
```bash
TMP=$(mktemp -d)
git clone --depth 1 "https://github.com/OWNER/REPO" "$TMP/skill"
SKILL_SRC="$TMP/skill"
```

**Subdirectory:**
```bash
TMP=$(mktemp -d)
git clone --depth 1 --filter=blob:none --sparse \
  "https://github.com/OWNER/REPO" "$TMP/skill"
cd "$TMP/skill"
git sparse-checkout set "PATH/TO/SKILL"
SKILL_SRC="$TMP/skill/PATH/TO/SKILL"
```

### 3. Verify it is a valid skill

Check that `SKILL.md` exists in `$SKILL_SRC`:
```bash
ls "$SKILL_SRC/SKILL.md"
```

Read the frontmatter `name:` field to get the canonical skill name. Use it as the destination directory name (fall back to the default directory name if the `name` field is absent or unparseable).

### 4. Copy into the skills repo

```bash
DEST="/Users/matthias/work/perso/skills/SKILL_NAME"
cp -r "$SKILL_SRC" "$DEST"
# Remove embedded .git if the full repo was cloned
rm -rf "$DEST/.git"
# Clean up temp clone
rm -rf "$TMP"
```

### 5. Register with agent harnesses

```bash
cd /Users/matthias/work/perso/skills
./link.sh
```

### 6. Commit and push

```bash
cd /Users/matthias/work/perso/skills
git add "SKILL_NAME/"
git commit -m "feat: add SKILL_NAME skill from GITHUB_URL"
git push
```

### 7. Confirm

Report:
- Skill name and description (from frontmatter)
- Files added to the repo
- Git commit hash
