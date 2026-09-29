#!/usr/bin/env python3
"""Linear document review loop for the `linear` skill.

The calling agent writes the draft; this moves it into a Linear document, opens
a review session, and comes back with what the reviewers said. It never invents
content.

    whoami                              the authenticated user
    resolve URL                         document identity (id, slug, title, url)
    fetch URL                           document body + every comment, as JSON
    plan    --url U --draft FILE        compare a draft to the live body (read-only)
    apply   --url U --draft FILE --mode replace|merge [--title T] [--confirmed]
                                        write the body, open a review session
    collect --url U [--all] [--json]    summarize what the review produced
    sessions                            list open review sessions
    end     --url U                     close the session

`plan` before `apply`. `apply` refuses a draft that would erase a largely
different document unless `--confirmed` says the user chose to go ahead.

Exit codes: 2 usage, 3 no open session, 4 divergence not confirmed.
"""

from __future__ import annotations

import argparse
import difflib
import hashlib
import json
import mimetypes
import os
import re
import subprocess
import sys
import urllib.parse
from datetime import datetime, timezone

STATE_DIR = os.environ.get("LINEAR_REVIEW_STATE_DIR") or os.path.expanduser(
    "~/.pi/agent/state/linear-review"
)

DOC_QUERY = """
query($id: String!, $first: Int!) {
  document(id: $id) {
    id
    slugId
    title
    url
    content
    project { name }
    issue { identifier title }
    team { key name }
    comments(first: $first) {
      nodes {
        id
        body
        quotedText
        parentId
        createdAt
        updatedAt
        resolvedAt
        url
        user { id displayName name }
      }
    }
  }
}
"""

VIEWER_QUERY = "query { viewer { id name displayName email } }"

IMAGE_RE = re.compile(r"!\[[^\]]*\]\([^)]*\)")
HEADING_RE = re.compile(r"^#{1,6}[ \t]")
WORD_RE = re.compile(r"[a-z0-9]+")


class UserError(Exception):
    """A problem the agent should read and act on, not a traceback."""


# --------------------------------------------------------------------------
# infrastructure
# --------------------------------------------------------------------------


def die(message: str, code: int = 1) -> "NoReturn":  # type: ignore[name-defined]
    sys.stderr.write(message.rstrip() + "\n")
    raise SystemExit(code)


def api(query: str, **variables: object) -> dict:
    """Run one GraphQL query through the `linear` CLI, query on stdin."""
    args = ["linear", "api"]
    for key, value in variables.items():
        args += ["--variable", f"{key}={value}"]
    proc = subprocess.run(args, input=query, text=True, capture_output=True)
    if proc.returncode != 0:
        die(proc.stderr.strip() or f"linear api exited {proc.returncode}")
    try:
        payload = json.loads(proc.stdout)
    except json.JSONDecodeError:
        die(f"linear api did not return JSON:\n{proc.stdout[:2000]}")
    if payload.get("errors"):
        die("; ".join(e.get("message", "?") for e in payload["errors"]))
    return payload.get("data") or {}


def slug_from(value: str) -> str:
    value = value.split("#", 1)[0].split("?", 1)[0].rstrip("/")
    return value.rsplit("/", 1)[-1]


def state_path(doc_id: str) -> str:
    return os.path.join(STATE_DIR, f"{doc_id}.json")


def load_session(doc_id: str) -> dict:
    path = state_path(doc_id)
    if not os.path.exists(path):
        die(
            f"no review session for {doc_id}. Run `apply` first.",
            code=3,
        )
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def save_session(session: dict) -> None:
    os.makedirs(STATE_DIR, exist_ok=True)
    with open(state_path(session["docId"]), "w", encoding="utf-8") as handle:
        json.dump(session, handle, indent=2)
        handle.write("\n")


def doc_by_url(url: str) -> dict:
    data = api(DOC_QUERY, id=slug_from(url), first=250)
    document = data.get("document")
    if not document:
        die(f"no document matches {url!r}")
    return document


def viewer() -> dict:
    return api(VIEWER_QUERY)["viewer"]


def display_name(user: dict | None) -> str:
    user = user or {}
    return user.get("displayName") or user.get("name") or "unknown"


def emit(payload: dict) -> None:
    json.dump(payload, sys.stdout, indent=2)
    sys.stdout.write("\n")


# --------------------------------------------------------------------------
# markdown comparison
# --------------------------------------------------------------------------


def normalize(text: str) -> str:
    """Canonical form for comparison.

    Ignores reflow, list-marker style, the blank line Linear inserts after a
    heading, the angle brackets Linear puts around an inline link destination,
    and where an image sits relative to the text around it: Linear promotes an
    inline image to a block of its own, so "Text: ![img](u)" and
    "Text:\n\n![img](u)" are the same document.
    """
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    lines: list[str] = []
    for line in text.split("\n"):
        line = re.sub(r"^(\s*)[-*+][ \t]+", r"\1- ", line.rstrip())
        line = re.sub(r"\]\(<([^>]+)>\)", r"](\1)", line)
        if IMAGE_RE.search(line):
            line = IMAGE_RE.sub(lambda match: "\n" + match.group(0) + "\n", line)
        # rstrip again: pulling an image off the line leaves the space before it.
        lines.extend(part.rstrip() for part in line.split("\n"))

    out: list[str] = []
    for line in lines:
        if not line:
            if not out or out[-1] == "" or HEADING_RE.match(out[-1]):
                continue
        out.append(line)
    while out and out[-1] == "":
        out.pop()

    def image_only(line: str) -> bool:
        return bool(IMAGE_RE.fullmatch(line.strip()))

    tightened: list[str] = []
    for line in out:
        if line == "" and tightened and image_only(tightened[-1]):
            continue
        tightened.append(line)
    result: list[str] = []
    for index, line in enumerate(tightened):
        if line == "" and index + 1 < len(tightened) and image_only(tightened[index + 1]):
            continue
        result.append(line)
    return "\n".join(result)


def heading_key(heading: str) -> str:
    """Match headings on their text, ignoring level and inline emphasis."""
    text = heading.lstrip("#").strip()
    text = re.sub(r"[*_`]", "", text)
    text = re.sub(r"\s+", " ", text)
    return text.lower()


def split_sections(text: str) -> list[tuple[str | None, str]]:
    """Markdown into (heading-line, body) pairs; the first may be a preamble."""
    blocks: list[tuple[str | None, str]] = []
    heading: str | None = None
    buf: list[str] = []
    for line in (text or "").splitlines(keepends=True):
        if HEADING_RE.match(line):
            if heading is not None or buf:
                blocks.append((heading, "".join(buf)))
            heading, buf = line.rstrip("\n"), []
        else:
            buf.append(line)
    if heading is not None or buf:
        blocks.append((heading, "".join(buf)))
    return blocks


def render_sections(blocks: list[tuple[str | None, str]]) -> str:
    # Linear returns the body without a trailing newline, so a heading has to
    # start its own line explicitly rather than trusting the previous block.
    out: list[str] = []
    for heading, body in blocks:
        if heading is not None:
            if out and out[-1] and not out[-1].endswith("\n"):
                out.append("\n")
            out.append(heading + "\n")
        out.append(body)
    return "".join(out).strip() + "\n"


def headings_of(text: str) -> list[str]:
    return [heading for heading, _ in split_sections(text) if heading]


def jaccard(left: set[str], right: set[str]) -> float:
    if not left and not right:
        return 1.0
    if not left or not right:
        return 0.0
    return len(left & right) / len(left | right)


def token_similarity(left: str, right: str) -> float:
    return round(jaccard(set(WORD_RE.findall(left.lower())), set(WORD_RE.findall(right.lower()))), 4)


def heading_similarity(left: str, right: str) -> float:
    return round(jaccard({heading_key(h) for h in headings_of(left)},
                         {heading_key(h) for h in headings_of(right)}), 4)


def compare(existing: str, draft: str) -> dict:
    if not existing.strip():
        verdict = "empty"
    elif normalize(existing) == normalize(draft):
        verdict = "identical"
    else:
        verdict = "minor"

    tokens = token_similarity(existing, draft)
    heads = heading_similarity(existing, draft)
    if verdict == "minor" and tokens < 0.6 and heads < 0.6:
        verdict = "major"

    existing_keys = {heading_key(h): h for h in headings_of(existing)}
    draft_keys = {heading_key(h): h for h in headings_of(draft)}
    only_in_document = [existing_keys[k] for k in existing_keys if k not in draft_keys]
    only_in_draft = [draft_keys[k] for k in draft_keys if k not in existing_keys]

    existing_bodies = {
        heading_key(h): body for h, body in split_sections(existing) if h
    }
    draft_bodies = {heading_key(h): body for h, body in split_sections(draft) if h}
    changed = [
        draft_keys[k]
        for k in draft_keys
        if k in existing_bodies and normalize(existing_bodies[k]) != normalize(draft_bodies[k])
    ]
    unchanged = len([k for k in draft_keys if k in existing_bodies]) - len(changed)

    return {
        "verdict": verdict,
        "similarity": {"tokens": tokens, "headings": heads},
        "sections": {
            "onlyInDocument": only_in_document,
            "onlyInDraft": only_in_draft,
            "changed": changed,
            "unchanged": max(unchanged, 0),
        },
    }


def merge_bodies(existing: str, draft: str) -> str:
    """Keep every existing section the draft does not touch, update matching
    headings in place, append the new ones."""
    existing_blocks = split_sections(existing)
    draft_blocks = split_sections(draft)
    if not headings_of(existing) or not headings_of(draft):
        raise UserError(
            "merge needs headings on both sides; the existing document and the draft "
            "must each have at least one `#` heading. Use `--mode replace` or abort."
        )

    # The preamble is a section like any other: the draft's only lands when the
    # document does not already have one, so an existing intro is never lost.
    draft_preamble = next(
        (body for heading, body in draft_blocks if heading is None), ""
    ).strip()
    existing_preamble = any(
        heading is None and body.strip() for heading, body in existing_blocks
    )

    result = list(existing_blocks)
    if draft_preamble and not existing_preamble:
        result = [(None, draft_preamble + "\n\n")] + result

    positions = {
        heading_key(heading): index
        for index, (heading, _) in enumerate(result)
        if heading
    }
    appended: list[tuple[str | None, str]] = []
    for heading, body in draft_blocks:
        if heading is None:
            continue
        key = heading_key(heading)
        if key in positions:
            result[positions[key]] = (heading, body)
        else:
            appended.append((heading, body))
    result.extend(appended)
    return render_sections(result)


def line_diff(before: str, after: str, context: int = 1) -> tuple[int, int, list[str], bool]:
    lines = list(
        difflib.unified_diff(
            normalize(before).splitlines(),
            normalize(after).splitlines(),
            lineterm="",
            n=context,
        )
    )
    added = sum(1 for line in lines if line.startswith("+") and not line.startswith("+++"))
    removed = sum(1 for line in lines if line.startswith("-") and not line.startswith("---"))
    truncated = len(lines) > 60
    return added, removed, lines[:60], truncated


def sha(text: str) -> str:
    return hashlib.sha256(normalize(text).encode("utf-8")).hexdigest()


def file_digest(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def human_time(value: str | None) -> str:
    if not value:
        return "?"
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return value
    return parsed.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")


def comment_time(value: str | None) -> str:
    return human_time(value)


def read_text(path: str, what: str) -> str:
    if not os.path.isfile(path):
        die(f"no {what} file at {path}")
    with open(path, encoding="utf-8") as handle:
        return handle.read()


# --------------------------------------------------------------------------
# images
# --------------------------------------------------------------------------
#
# --------------------------------------------------------------------------
# images
# --------------------------------------------------------------------------
#
# A reference to a local file ("![](./diagram.png)") means nothing to anyone
# reading the document: Linear cannot fetch the author's disk, so the image
# renders as "failed to load image". Local files are uploaded first and the
# reference is rewritten to the asset URL Linear gives back.
#
# Three things Linear does by itself, confirmed against live documents, and each
# one shapes what this code must not do:
#
#   * Remote images are re-hosted by Linear on write, so an http(s) URL is left
#     exactly as it is.
#   * Raw HTML does not survive its markdown. A left-alone <img src="..."> comes
#     back as `<img src="[url](<url>)">`, a broken link inside an attribute. An
#     <img> tag is therefore always converted to markdown, uploaded or not.
#   * Reference-style images are flattened: `![alt][ref]` plus `[ref]: url` is
#     stored as `![alt](url)` and the definition is dropped. Inlining them here
#     is what keeps a second `apply` from rewriting the same body forever.

INLINE_IMAGE_RE = re.compile(r"!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))")
HTML_IMG_TAG_RE = re.compile(r"<img\b[^>]*>", re.IGNORECASE)
SRC_ATTR_RE = re.compile(r"\bsrc\s*=\s*(?:\"([^\"]*)\"|'([^']*)'|([^\s>]+))", re.IGNORECASE)
ALT_ATTR_RE = re.compile(r"\balt\s*=\s*(?:\"([^\"]*)\"|'([^']*)'|([^\s>]+))", re.IGNORECASE)
REF_IMAGE_USE_RE = re.compile(r"!\[([^\]]*)\]\[([^\]]*)\]")
REF_LINK_USE_RE = re.compile(r"(?<!!)\[([^\]]*)\]\[([^\]]*)\]")
REF_DEF_RE = re.compile(r"^[ \t]*\[([^\]]+)\]:[ \t]*(\S+)[ \t]*$", re.MULTILINE)


def attr_value(match: re.Match | None) -> str:
    if not match:
        return ""
    return next((group for group in match.groups() if group), "")


def image_spans(text: str) -> list[tuple[int, int, str]]:
    """Inline markdown image URLs, as (start, end, url) spans."""
    spans: list[tuple[int, int, str]] = []
    for match in INLINE_IMAGE_RE.finditer(text):
        for index in (1, 2):
            if match.group(index):
                start, end = match.span(index)
                spans.append((start, end, match.group(index)))
                break
    return sorted(spans)


def html_image_tags(text: str) -> list[tuple[int, int, str, str]]:
    """Whole <img> tags, as (start, end, src, alt)."""
    tags: list[tuple[int, int, str, str]] = []
    for match in HTML_IMG_TAG_RE.finditer(text):
        src = attr_value(SRC_ATTR_RE.search(match.group(0)))
        if not src:
            continue
        tags.append((match.start(), match.end(), src, attr_value(ALT_ATTR_RE.search(match.group(0)))))
    return tags


def reference_images(text: str) -> list[tuple[int, int, str, str]]:
    """![alt][name] usages, as (start, end, alt, name). A collapsed `![alt][]`
    takes its name from the alt text."""
    usages: list[tuple[int, int, str, str]] = []
    for match in REF_IMAGE_USE_RE.finditer(text):
        alt, name = match.group(1), match.group(2) or match.group(1)
        usages.append((match.start(), match.end(), alt, name.strip().lower()))
    return usages


def reference_links(text: str) -> list[tuple[int, int, str, str]]:
    """[label][name] usages that are links rather than images, as
    (start, end, label, name). A collapsed `[label][]` takes its name from the
    label. Shortcut references (`[name]` alone) are deliberately not matched:
    they are indistinguishable from ordinary bracketed text."""
    usages: list[tuple[int, int, str, str]] = []
    for match in REF_LINK_USE_RE.finditer(text):
        label, name = match.group(1), match.group(2) or match.group(1)
        usages.append((match.start(), match.end(), label, name.strip().lower()))
    return usages


def reference_definitions(text: str) -> dict[str, tuple[int, int, str]]:
    """Definition lines, as name -> (start, end, url). The span includes the
    trailing newline so a dropped definition leaves no blank line behind."""
    definitions: dict[str, tuple[int, int, str]] = {}
    for match in REF_DEF_RE.finditer(text):
        end = match.end() + (1 if match.end() < len(text) and text[match.end()] == "\n" else 0)
        definitions[match.group(1).strip().lower()] = (match.start(), end, match.group(2))
    return definitions


def is_remote(url: str) -> bool:
    return url.strip().lower().startswith(
        ("http://", "https://", "data:", "mailto:", "#", "tel:")
    )


def resolve_local(url: str, draft_dir: str) -> str | None:
    """The file a reference points at, relative to the draft or the cwd."""
    raw = url.strip()
    if raw.lower().startswith("file://"):
        raw = raw[7:]
    raw = urllib.parse.unquote(raw)
    candidates = [raw] if os.path.isabs(raw) else [
        os.path.join(draft_dir, raw),
        os.path.join(os.getcwd(), raw),
    ]
    for candidate in candidates:
        if os.path.isfile(candidate):
            return os.path.abspath(candidate)
    return None


def collect_images(body: str, draft_path: str) -> list[dict]:
    """Describe every image reference, without uploading anything."""
    draft_dir = os.path.dirname(os.path.abspath(draft_path))
    items: list[dict] = []

    def describe(url: str, syntax: str) -> None:
        if is_remote(url):
            items.append(
                {
                    "reference": url,
                    "syntax": syntax,
                    "kind": "remote",
                    "path": None,
                    "exists": True,
                    "bytes": None,
                }
            )
            return
        resolved = resolve_local(url, draft_dir)
        items.append(
            {
                "reference": url,
                "syntax": syntax,
                "kind": "local",
                "path": resolved,
                "exists": resolved is not None,
                "bytes": os.path.getsize(resolved) if resolved else None,
            }
        )

    for _, _, url in image_spans(body):
        describe(url, "markdown")
    for _, _, url, _ in html_image_tags(body):
        describe(url, "html")
    for name, (_, _, url) in reference_definitions(body).items():
        if any(seen == name for _, _, _, seen in reference_images(body)):
            describe(url, "reference")
    return items


def upload_asset(path: str, public: bool) -> str:
    """Upload one file and return the asset URL to put in the markdown.

    `makePublic` stays false by default because that is what Linear itself does
    for document images: the asset lands on uploads.linear.app and the Linear
    client authenticates the request. Public puts it on public.linear.app, which
    anyone can read without signing in.
    """
    filename = os.path.basename(path)
    content_type = mimetypes.guess_type(path)[0] or "application/octet-stream"
    size = os.path.getsize(path)
    query = (
        "mutation {\n"
        f"  fileUpload(filename: {json.dumps(filename)}, "
        f"contentType: {json.dumps(content_type)}, size: {size}, "
        f"makePublic: {str(public).lower()}) {{\n"
        "    success\n"
        "    uploadFile { uploadUrl assetUrl headers { key value } }\n"
        "  }\n"
        "}"
    )
    payload = api(query).get("fileUpload") or {}
    if not payload.get("success"):
        raise UserError(f"Linear refused the upload of {path} ({content_type}, {size} bytes)")

    upload = payload["uploadFile"]
    args = [
        "curl", "-sf", "-X", "PUT",
        "--upload-file", path,
        "-H", f"Content-Type: {content_type}",
    ]
    for header in upload["headers"]:
        args += ["-H", f'{header["key"]}: {header["value"]}']
    args.append(upload["uploadUrl"])
    proc = subprocess.run(args, capture_output=True, text=True)
    if proc.returncode != 0:
        raise UserError(f"upload of {path} failed: {proc.stderr.strip() or proc.returncode}")
    return upload["assetUrl"]


def prepare_body(
    body: str,
    draft_path: str,
    public: bool,
    upload: bool = True,
    cache: dict[str, str] | None = None,
) -> tuple[str, list[dict]]:
    """Rewrite a body into the form Linear actually stores.

    Local image files are uploaded and their references replaced with the asset
    URL; remote URLs are handed to Linear, which re-hosts them itself; <img> tags
    and reference-style images and links are inlined, because Linear keeps no raw
    HTML and flattens references on write. Writing the flattened form is what
    makes a second `apply` of the same draft a no-op instead of an endless
    rewrite.

    `cache` maps a file's content digest to its asset URL and is persisted in the
    review session, so re-applying reuses the assets already in the document
    rather than uploading the same screenshot again under a new URL.
    """
    draft_dir = os.path.dirname(os.path.abspath(draft_path))
    cache = {} if cache is None else cache
    replacements: dict[tuple[int, int], str] = {}
    uploads: list[dict] = []

    def target(url: str) -> str:
        if is_remote(url) or not upload:
            return url
        resolved = resolve_local(url, draft_dir)
        if not resolved:
            raise UserError(f"image file not found: {url}")
        key = f"{file_digest(resolved)}:{public}"
        if key not in cache:
            cache[key] = upload_asset(resolved, public)
            uploads.append(
                {
                    "reference": url,
                    "path": resolved,
                    "bytes": os.path.getsize(resolved),
                    "assetUrl": cache[key],
                    "public": public,
                }
            )
        return cache[key]

    definitions = reference_definitions(body)

    # Inline images: the URL is the only part that changes.
    for start, end, url in image_spans(body):
        replacements[(start, end)] = target(url)

    # <img> tags: the whole tag becomes markdown. Only images are uploaded, so a
    # link to a local file keeps its path rather than pushing a stray file into
    # Linear's asset store.
    for start, end, url, alt in html_image_tags(body):
        replacements[(start, end)] = f"![{alt}]({target(url)})"

    # Reference-style images: inline them, uploading the file they point at.
    image_usages = reference_images(body)
    for start, end, alt, name in image_usages:
        if name in definitions:
            replacements[(start, end)] = f"![{alt}]({target(definitions[name][2])})"

    # Reference-style links: inline them, leaving the destination untouched.
    link_usages = reference_links(body)
    for start, end, label, name in link_usages:
        if name in definitions:
            replacements[(start, end)] = f"[{label}]({definitions[name][2]})"

    # A definition whose every usage is now inline is dead weight Linear would
    # drop anyway. One still referenced by an untouched shortcut stays.
    inlined: dict[str, int] = {}
    for _, _, _, name in (*image_usages, *link_usages):
        if name in definitions:
            inlined[name] = inlined.get(name, 0) + 1
    blanked = body
    for start, end, _ in definitions.values():
        blanked = blanked[:start] + " " * (end - start) + blanked[end:]
    for name, (start, end, _) in definitions.items():
        remaining = len(
            re.findall(r"\[" + re.escape(name) + r"\]", blanked, re.IGNORECASE)
        )
        if remaining == inlined.get(name, 0):
            replacements[(start, end)] = ""

    rewritten = body
    for start, end in sorted(replacements, reverse=True):
        rewritten = rewritten[:start] + replacements[(start, end)] + rewritten[end:]
    return rewritten, uploads


# --------------------------------------------------------------------------
# commands
# --------------------------------------------------------------------------


def cmd_whoami(_: argparse.Namespace) -> int:
    emit(viewer())
    return 0


def cmd_resolve(args: argparse.Namespace) -> int:
    document = doc_by_url(args.url)
    emit(
        {
            "id": document["id"],
            "slugId": document["slugId"],
            "title": document["title"],
            "url": document["url"],
            "project": (document.get("project") or {}).get("name"),
            "issue": (document.get("issue") or {}).get("identifier"),
            "bodyChars": len(document.get("content") or ""),
            "stateFile": state_path(document["id"]),
        }
    )
    return 0


def cmd_fetch(args: argparse.Namespace) -> int:
    emit(doc_by_url(args.url))
    return 0


def cmd_plan(args: argparse.Namespace) -> int:
    draft = read_text(args.draft, "draft")
    document = doc_by_url(args.url)
    existing = document.get("content") or ""
    result = compare(existing, draft)

    images = collect_images(draft, args.draft)
    local_images = [item for item in images if item["kind"] == "local"]
    html_images = [item for item in images if item["syntax"] == "html"]
    missing = [item["reference"] for item in local_images if not item["exists"]]
    warnings = []
    if local_images:
        warnings.append(
            f"{len(local_images)} local image reference(s) will be uploaded to Linear on apply; "
            "the markdown will be rewritten to the asset URLs"
        )
    if html_images:
        warnings.append(
            f"{len(html_images)} <img> tag(s) will be converted to markdown: Linear keeps no "
            "raw HTML and renders an <img> tag as a broken link"
        )
    if missing:
        warnings.append(
            "these image files do not exist and Linear cannot load them: " + ", ".join(missing)
        )

    actions = ["abort"]
    if result["verdict"] == "major":
        actions = [
            "apply --mode replace --confirmed   # discard the current body",
            "apply --mode merge --confirmed     # keep untouched sections, replace matching ones, append new ones",
            "abort                              # change nothing",
        ]
    elif result["verdict"] != "identical":
        actions = [
            "apply --mode replace",
            "apply --mode merge                 # keep existing sections the draft does not touch",
            "abort",
        ]
    else:
        actions = ["apply --mode replace           # no rewrite needed, opens the review session", "abort"]

    emit(
        {
            "document": {
                "id": document["id"],
                "slugId": document["slugId"],
                "title": document["title"],
                "url": document["url"],
                "bodyChars": len(existing),
                "headings": headings_of(existing),
            },
            "draft": {
                "path": os.path.abspath(args.draft),
                "chars": len(draft),
                "headings": headings_of(draft),
            },
            "verdict": result["verdict"],
            "similarity": result["similarity"],
            "sections": result["sections"],
            "images": {
                "local": local_images,
                "html": html_images,
                "remote": len([item for item in images if item["kind"] == "remote"]),
                "missing": missing,
            },
            "warnings": warnings,
            "stateFile": state_path(document["id"]),
            "next": actions,
        }
    )
    return 0


def cmd_apply(args: argparse.Namespace) -> int:
    draft = read_text(args.draft, "draft")

    # Catch this before the divergence question: a broken image is cheap to fix
    # now and expensive to notice after the document is circulated.
    if not args.skip_image_upload:
        missing = [
            item["reference"]
            for item in collect_images(draft, args.draft)
            if item["kind"] == "local" and not item["exists"]
        ]
        if missing:
            die(
                "draft references image files that do not exist:\n  "
                + "\n  ".join(missing)
                + "\nLinear cannot fetch a local path, so these would render as broken "
                "images.\nFix the paths, or pass --skip-image-upload to write the "
                "references as-is."
            )

    document = doc_by_url(args.url)
    existing = document.get("content") or ""
    result = compare(existing, draft)

    if result["verdict"] == "major" and not args.confirmed:
        die(
            "refusing to overwrite: the draft is largely different from the live document "
            f"(token similarity {result['similarity']['tokens']}, heading similarity "
            f"{result['similarity']['headings']}).\n"
            f"  only in document: {', '.join(result['sections']['onlyInDocument']) or '(none)'}\n"
            f"  only in draft:    {', '.join(result['sections']['onlyInDraft']) or '(none)'}\n"
            "Run `plan` first, ask the user to choose replace / merge / abort, then re-run "
            "with `--confirmed` and the chosen `--mode`.",
            code=4,
        )

    if args.mode == "merge":
        try:
            body = merge_bodies(existing, draft)
        except UserError as error:
            die(str(error))
    else:
        body = draft

    # Rewrite after the divergence guard, so a refused apply uploads nothing.
    # The <img> conversion runs either way: Linear renders no raw HTML, so a
    # skipped upload still has to come back as markdown.
    session_file = state_path(document["id"])
    previous: dict = {}
    if os.path.exists(session_file):
        with open(session_file, encoding="utf-8") as handle:
            previous = json.load(handle)
    asset_cache = dict(previous.get("assetCache") or {})

    uploads: list[dict] = []
    try:
        body, uploads = prepare_body(
            body,
            args.draft,
            args.public_assets,
            upload=not args.skip_image_upload,
            cache=asset_cache,
        )
    except UserError as error:
        die(str(error))

    title = args.title or document["title"]
    unchanged = normalize(body) == normalize(existing)

    if not unchanged:
        query = (
            "mutation {\n"
            "  documentUpdate(\n"
            f"    id: {json.dumps(document['slugId'])},\n"
            "    input: {\n"
            f"      content: {json.dumps(body)},\n"
            f"      title: {json.dumps(title)}\n"
            "    }\n"
            "  ) {\n"
            "    success\n"
            "    document { id slugId title url updatedAt }\n"
            "  }\n"
            "}"
        )
        payload = api(query)["documentUpdate"]
        if not payload.get("success"):
            die("documentUpdate reported failure")
        written = payload["document"]
        # Linear rewrites markdown on write (list markers, blank lines). The
        # baseline for "did the reviewer edit this?" has to be Linear's own
        # rendering, otherwise every collect reports a phantom edit.
        stored = doc_by_url(args.url)
    else:
        written = {
            "id": document["id"],
            "slugId": document["slugId"],
            "title": document["title"],
            "url": document["url"],
        }
        stored = document

    session = {
        "docId": document["id"],
        "slugId": document["slugId"],
        "url": written["url"],
        "title": written["title"],
        "mode": args.mode,
        "verdict": result["verdict"],
        "openedAt": now_iso(),
        "wroteAt": now_iso(),
        "wrote": not unchanged,
        "bodyAfter": stored.get("content") or "",
        "bodyHashAfter": sha(stored.get("content") or ""),
        "baseCommentIds": [node["id"] for node in document["comments"]["nodes"]],
        "collectedIds": [],
        "reportedEdits": {},
        "assetCache": asset_cache,
    }
    save_session(session)

    emit(
        {
            "document": written,
            "mode": args.mode,
            "verdict": result["verdict"],
            "wrote": not unchanged,
            "imagesUploaded": uploads,
            "session": state_path(document["id"]),
        }
    )
    return 0


def build_threads(nodes: list[dict], viewer_id: str, fresh: set[str]) -> list[dict]:
    by_id = {node["id"]: node for node in nodes}
    roots: dict[str, list[dict]] = {}
    for node in nodes:
        if node["id"] not in fresh:
            continue
        root_id = node.get("parentId") or node["id"]
        roots.setdefault(root_id, []).append(node)

    threads: list[dict] = []
    for root_id, members in roots.items():
        root = by_id.get(root_id) or members[0]
        replies = sorted(
            (node for node in members if node["id"] != root_id),
            key=lambda node: node["createdAt"],
        )
        threads.append(
            {
                "rootId": root_id,
                "url": root.get("url"),
                "author": display_name(root.get("user")),
                "authorIsViewer": (root.get("user") or {}).get("id") == viewer_id,
                "at": root["createdAt"],
                "quote": root.get("quotedText"),
                "body": root.get("body") or "",
                "resolved": bool(root.get("resolvedAt")),
                "resolvedAt": root.get("resolvedAt"),
                "replies": [
                    {
                        "id": reply["id"],
                        "url": reply.get("url"),
                        "author": display_name(reply.get("user")),
                        "authorIsViewer": (reply.get("user") or {}).get("id") == viewer_id,
                        "at": reply["createdAt"],
                        "body": reply.get("body") or "",
                    }
                    for reply in replies
                ],
            }
        )

    threads.sort(key=lambda thread: (thread["resolved"], thread["at"]))
    return threads


def render_markdown(summary: dict) -> str:
    document = summary["document"]
    counts = summary["counts"]
    out: list[str] = []
    out.append(f"# Review summary — {document['title']}")
    out.append("")
    out.append(document["url"])
    out.append("")
    header = (
        f"{counts['newComments']} new comment(s) in {counts['threads']} thread(s) "
        f"· {counts['openThreads']} unresolved · collected {document['collectedAt']}"
    )
    if summary["written"]:
        header += f" · written {human_time(summary['writtenAt'])}"
    out.append(header)
    out.append("")

    if not summary["threads"]:
        out.append("No new comments.")
        out.append("")

    open_threads = [t for t in summary["threads"] if not t["resolved"]]
    closed_threads = [t for t in summary["threads"] if t["resolved"]]

    for label, group in (("Open threads", open_threads), ("Resolved threads", closed_threads)):
        if not group:
            continue
        out.append(f"## {label}")
        out.append("")
        for index, thread in enumerate(group, start=1):
            who = thread["author"] + (" (you)" if thread["authorIsViewer"] else "")
            quote = f" on “{thread['quote'].strip()}”" if (thread["quote"] or "").strip() else ""
            suffix = " — resolved" if thread["resolved"] else ""
            out.append(f"**{index}. {who}**{quote} · {comment_time(thread['at'])}{suffix}")
            for line in thread["body"].strip().splitlines():
                out.append(f"> {line}")
            for reply in thread["replies"]:
                author = reply["author"] + (" (you)" if reply["authorIsViewer"] else "")
                first, *rest = (reply["body"].strip().splitlines() or [""])
                out.append(f"  ↳ **{author}** · {comment_time(reply['at'])}: {first}")
                for line in rest:
                    out.append(f"    {line}")
            if thread.get("url"):
                out.append(f"  <{thread['url']}>")
            out.append("")

    change = summary.get("bodyChange")
    if change:
        out.append("## Body edits")
        out.append("")
        out.append(
            "The reviewer edited the document body after it was written "
            f"({change['added']} added, {change['removed']} removed line(s))."
        )
        out.append("")
        out.append("```diff")
        out.extend(change["diff"])
        if change["truncated"]:
            out.append("… diff truncated")
        out.append("```")
        out.append("")

    if summary["editedComments"]:
        out.append("## Comments edited since the write")
        out.append("")
        for node in summary["editedComments"]:
            who = node["author"] + (" (you)" if node["authorIsViewer"] else "")
            out.append(f"- **{who}** · {comment_time(node['at'])}: {node['body']}")
        out.append("")

    return "\n".join(out).rstrip() + "\n"


def cmd_collect(args: argparse.Namespace) -> int:
    document = doc_by_url(args.url)
    session = load_session(document["id"])
    who = viewer()

    nodes = document["comments"]["nodes"]
    known = set(session["baseCommentIds"])
    collected = set(session.get("collectedIds") or [])
    fresh = {
        node["id"]
        for node in nodes
        if node["id"] not in known and (args.all or node["id"] not in collected)
    }

    threads = build_threads(nodes, who["id"], fresh)
    written_at = session["wroteAt"]

    # A comment that predates the write but was edited afterwards is not a new
    # thread, so it is reported on its own and once per edit, not once per poll.
    reported_edits = dict(session.get("reportedEdits") or {})
    edited_comments = []
    for node in nodes:
        updated_at = node.get("updatedAt") or node["createdAt"]
        if node["id"] not in known or updated_at <= written_at:
            continue
        if reported_edits.get(node["id"]) == updated_at:
            continue
        reported_edits[node["id"]] = updated_at
        edited_comments.append(
            {
                "id": node["id"],
                "url": node.get("url"),
                "author": display_name(node.get("user")),
                "authorIsViewer": (node.get("user") or {}).get("id") == who["id"],
                "at": updated_at,
                "body": node.get("body") or "",
            }
        )

    body_change = None
    if session.get("bodyHashAfter") and sha(document.get("content") or "") != session["bodyHashAfter"]:
        added, removed, diff, truncated = line_diff(
            session.get("bodyAfter", ""), document.get("content") or ""
        )
        body_change = {"added": added, "removed": removed, "diff": diff, "truncated": truncated}

    summary = {
        "document": {
            "id": document["id"],
            "slugId": document["slugId"],
            "title": document["title"],
            "url": document["url"],
            "collectedAt": human_time(now_iso()),
        },
        "written": session.get("wrote", True),
        "writtenAt": written_at,
        "counts": {
            "newComments": sum(1 + len(t["replies"]) for t in threads),
            "threads": len(threads),
            "openThreads": sum(1 for t in threads if not t["resolved"]),
            "bodyChanged": body_change is not None,
        },
        "bodyChange": body_change,
        "threads": threads,
        "editedComments": edited_comments,
    }

    session["collectedIds"] = sorted({*(session.get("collectedIds") or []), *fresh})
    session["reportedEdits"] = reported_edits
    session["lastCollectedAt"] = now_iso()
    session["bodyAfter"] = document.get("content") or ""
    session["bodyHashAfter"] = sha(document.get("content") or "")
    save_session(session)

    if args.json:
        emit(summary)
    else:
        sys.stdout.write(render_markdown(summary))
    return 0


def cmd_sessions(_: argparse.Namespace) -> int:
    if not os.path.isdir(STATE_DIR):
        print("no review sessions")
        return 0
    rows = []
    for name in sorted(os.listdir(STATE_DIR)):
        if not name.endswith(".json"):
            continue
        with open(os.path.join(STATE_DIR, name), encoding="utf-8") as handle:
            session = json.load(handle)
        rows.append(
            {
                "docId": session.get("docId"),
                "title": session.get("title"),
                "url": session.get("url"),
                "mode": session.get("mode"),
                "openedAt": session.get("openedAt"),
                "collected": len(session.get("collectedIds") or []),
            }
        )
    if not rows:
        print("no review sessions")
        return 0
    emit({"sessions": rows})
    return 0


def cmd_end(args: argparse.Namespace) -> int:
    document = doc_by_url(args.url)
    path = state_path(document["id"])
    if not os.path.exists(path):
        die(f"no review session for {document['id']}", code=3)
    os.remove(path)
    print(f"closed review session for {document['title']} ({path})")
    return 0


# --------------------------------------------------------------------------
# cli
# --------------------------------------------------------------------------


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="linear_review.py",
        description="Move a draft into a Linear document, open a review session, and summarize what the reviewers said.",
        epilog="Run `plan` before `apply`.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("whoami", help="the authenticated user").set_defaults(func=cmd_whoami)

    p = sub.add_parser("resolve", help="document identity")
    p.add_argument("url")
    p.set_defaults(func=cmd_resolve)

    p = sub.add_parser("fetch", help="document body and comments as JSON")
    p.add_argument("url")
    p.set_defaults(func=cmd_fetch)

    p = sub.add_parser("plan", help="compare a draft to the live document (read-only)")
    p.add_argument("--url", required=True)
    p.add_argument("--draft", required=True)
    p.set_defaults(func=cmd_plan)

    p = sub.add_parser("apply", help="write the body and open a review session")
    p.add_argument("--url", required=True)
    p.add_argument("--draft", required=True)
    p.add_argument("--mode", choices=("replace", "merge"), default="replace")
    p.add_argument("--title")
    p.add_argument(
        "--confirmed",
        action="store_true",
        help="the user chose this on a `major` divergence",
    )
    p.add_argument(
        "--public-assets",
        action="store_true",
        help="upload images publicly reachable instead of Linear's authenticated asset store",
    )
    p.add_argument(
        "--skip-image-upload",
        action="store_true",
        help="write image references as-is, leaving them unrenderable",
    )
    p.set_defaults(func=cmd_apply)

    p = sub.add_parser("collect", help="summarize the review")
    p.add_argument("--url", required=True)
    p.add_argument("--all", action="store_true", help="include comments already collected")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_collect)

    sub.add_parser("sessions", help="list open review sessions").set_defaults(func=cmd_sessions)

    p = sub.add_parser("end", help="close the review session")
    p.add_argument("--url", required=True)
    p.set_defaults(func=cmd_end)

    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except UserError as error:
        die(str(error))


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
