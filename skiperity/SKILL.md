---
name: skiperity
description: "Answer security questionnaires using the knowledge base and past answers. Supports subcommands: index, learn, extract, answer, bake."
allowed-tools: Bash(python3:*), Read, Write, Glob, Grep, Edit
---

# Skiperity — Security Questionnaire Agent

Answer security questionnaires by matching questions against a knowledge base of policies and past validated answers.

## Project Structure

```
skiperity/
├── knowledge/
│   ├── policies/
│   │   ├── raw/              ← original PDFs
│   │   └── md/              ← extracted markdown with page markers (via index)
│   └── answers_db.yaml      ← canonical Q&A database (English-normalized)
├── input/
│   ├── raw/                 ← incoming questionnaires (xlsx/docx)
│   └── md/                  ← readable markdown extractions
├── working/
│   ├── *.map.yaml           ← structure manifests
│   ├── *.answers.yaml       ← generated answers
│   └── conflicts.yaml       ← flagged conflicts (backfill)
├── output/
│   ├── raw/                 ← delivered files (after bake)
│   └── md/                  ← markdown of delivered files
└── scripts/                 ← utility scripts
```

## Subcommands

When invoked, determine which subcommand to execute based on the user's request:

### `index`

Convert all PDFs in `knowledge/policies/raw/` to markdown.

```bash
python3 scripts/index.py [--force]
```

Only processes files without an existing .md counterpart (incremental).

---

### `learn`

Ingest completed questionnaire(s) from `output/raw/` into `knowledge/answers_db.yaml`.

**Workflow:**

1. Extract the binary file to markdown using:
   ```bash
   python3 scripts/extract_questionnaire.py "output/raw/<filename>" "output/md/<basename>.md"
   ```

2. Read the extracted markdown to understand the Q&A structure.

3. For each question-answer pair found:
   - Normalize the question to English (if not already)
   - Assign topic tags from this list: governance, security_policy, access_control, encryption, network_security, incident_management, business_continuity, vulnerability_management, change_management, physical_security, hr_security, data_protection, privacy, compliance, audit, vendor_management, asset_management, development_security, backup, monitoring
   - Determine confidence: "high" if the answer is substantive, "low" if it's just "Yes"/"Oui" with no justification
   - Check for conflicts against existing entries in answers_db.yaml

4. Load existing `knowledge/answers_db.yaml` (or create if missing).

5. For each new entry:
   - If a semantically equivalent question already exists with a DIFFERENT answer → add to `working/conflicts.yaml`
   - If a semantically equivalent question exists with the SAME answer → update `used_in` and `last_used`
   - If no equivalent exists → append as new entry

6. Write updated `knowledge/answers_db.yaml`.

**Schema for answers_db.yaml:**

```yaml
entries:
  - id: "short-kebab-case-id"
    question: "English-normalized question text"
    topics: ["topic1", "topic2"]
    response: "Yes/No/Partial/NA or short answer"
    justification: "Detailed English justification"
    sources: []  # policy filenames, populated later or by answer step
    confidence: "high"  # or "low" or "unsourced"
    last_used: "2026-06-15"
    used_in: ["J&J TPRM 2025", "Allianz DDQ 2025"]
```

**For backfill mode (multiple files):**
- Process all files in `output/raw/` that don't have entries in answers_db.yaml
- Collect all conflicts in `working/conflicts.yaml` for user review after

---

### `extract`

Parse a new incoming questionnaire and produce a structure manifest.

**Workflow:**

1. Extract the binary to markdown:
   ```bash
   python3 scripts/extract_questionnaire.py "input/raw/<filename>" "input/md/<basename>.md"
   ```

2. Read the markdown and identify all questions and their answer locations.

3. Produce `working/<basename>.map.yaml`:

```yaml
source_file: "input/raw/<filename>"
format: "xlsx"  # or "docx"
language: "fr"  # detected from content
questions:
  - id: "q1"
    text: "Original question text as-is"
    section: "Sheet name or section heading"
    location:
      # For xlsx:
      sheet: "Exigences SECURITE"
      response_cell: "D4"
      justification_cell: "E4"
      # For docx:
      table_index: 10
      row: 3
      col: 2
    answer_type: "choice"  # choice, free_text, yes_no, multi_select
    choices: ["Oui", "Non", "Partiel", "En cours", "NA"]  # if applicable
```

4. Present the manifest summary to the user for validation.

---

### `answer`

Generate answers for a questionnaire using the knowledge base and answers DB.

**Workflow:**

1. Read `working/<basename>.map.yaml` to get the list of questions.

2. For each question:
   a. Search `knowledge/answers_db.yaml` for semantically similar past answers.
   b. If not found or confidence is low, identify 2-4 relevant policy files by matching the question topic against the 74 filenames in `knowledge/policies/md/`.
   c. Read the relevant policy markdown files.
   d. Generate an answer in the questionnaire's language (from manifest `language` field).
   e. Record sources and confidence.

3. Produce `working/<basename>.answers.yaml`:

```yaml
source_manifest: "working/<basename>.map.yaml"
language: "fr"
generated_at: "2026-06-19T14:30:00Z"
answers:
  - id: "q1"
    response: "Oui"
    justification: "Translated justification text..."
    sources:
      - document: "Information Security Policy.pdf"
        page: 3
        section: "Purpose"
      - from_db: "security-policy-existence"
    confidence: "high"  # high, low, unsourced
    flag: null  # or "No matching policy found. Based on general knowledge."
```

4. Present a summary to the user:
   - Total questions answered
   - Count by confidence level (high/low/unsourced)
   - List of flagged answers needing attention

---

### `bake`

Write approved answers back into the binary questionnaire file.

**Workflow:**

1. Read `working/<basename>.answers.yaml` and `working/<basename>.map.yaml`.

2. Copy the source file from `input/raw/` to `output/raw/` (clean the filename if needed).

3. For xlsx files: use openpyxl to write into specific cells.
   For docx files: use python-docx to write into specific table cells.

4. Only write into identified answer cells — never modify question cells or formatting.

5. Also produce `output/md/<basename>.md` by re-extracting the written file.

6. Report what was written and any cells that couldn't be filled.

**Note:** After baking, the user reviews the actual file. Once satisfied, they invoke `learn` to add the approved answers to the database.

---

## Key Principles

1. **Never answer without citing sources.** Every answer must reference either a policy document (with page number) or a past answer from the DB. If unsourced, flag it clearly.

2. **Normalize to English internally.** The answers_db stores everything in English. Translation happens at answer/bake time based on the questionnaire's language.

3. **Surgical edits only.** When writing back to files, only touch answer cells. Never rewrite document structure or formatting.

4. **Flag conflicts.** When learning, if an existing answer contradicts a new one, write to conflicts.yaml and let the human decide.

5. **Topic matching by filename.** When selecting policy documents to read, use the question's semantic content to pick 2-4 relevant files from the 74 available by their descriptive filenames.

## Available Policy Files

The knowledge base contains these policy documents (in `knowledge/policies/md/`):

- AI Development Policy, AI Usage Policy
- Acceptable Usage Policy, Access Control Policy/Procedure
- Asset Management Policy/Procedure
- Business Continuity & Disaster Recovery Policy, Business Continuity Plan
- Change Management Policy
- CodeOfConduct
- Communications & Network Security Policy
- Compliance Policy/Procedure
- Data Backup Policy, Data Breach Notification Policy, Data Classification Policy
- Data Protection Policy, Data Retention Policy
- DataBreachManagementProcedure, DataPrivacyPolicy, DataProcessingPolicy
- DataRetentionPolicy, DataTransferImpactAssessment
- Disaster Recovery Policy, Encryption Policy, Endpoint Security Policy
- HR Security Policy/Procedure
- Incident Management Policy/Procedure
- Information Security Policy, Media Disposal Policy
- Network Security Procedure, Notification of Authorities
- Operation Security Policy, Operations Security Procedure
- Password Policy, Physical & Environmental Security Policy/Procedure
- Privacy By Design Policy
- PolicyAssetManagement, PolicyClearDesk, PolicyCommunicationSecurity
- PolicyDocumentManagement, PolicyOfficeTeleworking, PolicyOperationSecurity
- PolicyResponsibleDisclosure, PolicySecureSDLC, PolicyStatementOfContext
- ProcessAccessControl, ProcessAssetWiping, ProcessBusinessContinuity
- ProcessChangeManagement, ProcessIncidentManagement
- ProcessManagementOfNonconformity, ProcessManagementReview
- ProcessVulnerabilityAssessment
- Risk Assessment & Management Policy
- SDLC Procedure
- StandardAntiMalware, StandardAssetManagement, StandardAuthentication
- StandardEndpointSecurity, StandardHumanResourceSecurity
- StandardInformationSecurityManagementFramework
- StandardInternalAudits, StandardIsmsDocumentManagement
- StandardRecordsManagement, StandardRiskManagement
- System Acquisition and Development Lifecycle Policy
- Vendor Management Policy/Procedure
- Vulnerability Management Policy
