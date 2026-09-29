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
import os
import re
import subprocess
import sys
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
    """Canonical form that ignores reflow, list-marker style and the blank line
    Linear inserts after a heading, so none of those read as a change."""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    lines = [
        re.sub(r"^(\s*)[-*+][ \t]+", r"\1- ", line.rstrip())
        for line in text.split("\n")
    ]
    out: list[str] = []
    for line in lines:
        if not line:
            if not out or out[-1] == "" or HEADING_RE.match(out[-1]):
                continue
        out.append(line)
    while out and out[-1] == "":
        out.pop()
    return "\n".join(out)


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
            "stateFile": state_path(document["id"]),
            "next": actions,
        }
    )
    return 0


def cmd_apply(args: argparse.Namespace) -> int:
    draft = read_text(args.draft, "draft")
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
    }
    save_session(session)

    emit(
        {
            "document": written,
            "mode": args.mode,
            "verdict": result["verdict"],
            "wrote": not unchanged,
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
    parser = argparse.ArgumentParser(prog="linear_review.py", description=__doc__)
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
