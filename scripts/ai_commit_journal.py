#!/usr/bin/env python3
import argparse
import datetime as dt
import json
import os
import pathlib
import re
import shlex
import subprocess
import sys
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Tuple

MARKER = "<!-- ai-commit-journal:v1 -->"
GIT_COMMIT_TIME_PLACEHOLDER = "__AI_COMMIT_JOURNAL_GIT_COMMIT_TIME_PENDING__"
DOCS_DIR_REL = pathlib.Path("docs") / "changes"
HOOKS_DIR_REL = pathlib.Path(".githooks")
PRECOMMIT_HOOK_REL = HOOKS_DIR_REL / "pre-commit"
POSTCOMMIT_HOOK_REL = HOOKS_DIR_REL / "post-commit"
MAX_USER_MSGS = 6
MAX_AGENT_MSGS = 8
MAX_EXCERPTS = 6


class JournalError(RuntimeError):
    pass


@dataclass
class ChangedFile:
    status: str
    path: str
    old_path: Optional[str] = None
    added: Optional[int] = None
    deleted: Optional[int] = None


@dataclass
class SessionContext:
    session_id: str
    file_path: pathlib.Path
    session_timestamp: Optional[str]
    cwd: str
    user_messages: List[str] = field(default_factory=list)
    agent_messages: List[str] = field(default_factory=list)
    context_window_reason: str = "session-start"
    context_window_start_timestamp: Optional[str] = None
    context_window_end_timestamp: Optional[str] = None
    last_successful_push_timestamp: Optional[str] = None


@dataclass
class StagedSnapshot:
    changed_files: List[ChangedFile]
    diff_stat_text: str
    total_added: int
    total_deleted: int
    file_count: int
    top_dirs: List[str]


@dataclass
class JournalDraft:
    path: pathlib.Path
    generated_at_iso: str
    commit_subject_guess: str


@dataclass
class HeadCommitInfo:
    commit_hash: str
    committer_time_iso: str


@dataclass
class TimelineMessage:
    timestamp: Optional[str]
    timestamp_dt: Optional[dt.datetime]
    role: str
    text: str


def eprint(msg: str) -> None:
    print(msg, file=sys.stderr)


def run(cmd: Sequence[str], cwd: Optional[pathlib.Path] = None, check: bool = True, env: Optional[Dict[str, str]] = None) -> subprocess.CompletedProcess:
    proc = subprocess.run(list(cmd), cwd=str(cwd) if cwd else None, check=False, text=True, capture_output=True, env=env)
    if check and proc.returncode != 0:
        raise JournalError(f"Command failed ({proc.returncode}): {' '.join(shlex.quote(c) for c in cmd)}\n{proc.stderr.strip()}")
    return proc


def git(repo_root: pathlib.Path, args: Sequence[str], check: bool = True, env: Optional[Dict[str, str]] = None) -> subprocess.CompletedProcess:
    return run(["git", *args], cwd=repo_root, check=check, env=env)


def git_out(repo_root: pathlib.Path, args: Sequence[str]) -> str:
    return git(repo_root, args).stdout.strip()


def get_repo_root() -> pathlib.Path:
    try:
        return pathlib.Path(git_out(pathlib.Path.cwd(), ["rev-parse", "--show-toplevel"]))
    except JournalError as exc:
        raise JournalError("Not inside a git repository") from exc


def get_git_dir(repo_root: pathlib.Path) -> pathlib.Path:
    git_dir = git_out(repo_root, ["rev-parse", "--git-dir"])
    p = pathlib.Path(git_dir)
    if not p.is_absolute():
        p = repo_root / p
    return p.resolve()


def now_local() -> dt.datetime:
    return dt.datetime.now().astimezone()


def iso_local(ts: Optional[dt.datetime] = None) -> str:
    return (ts or now_local()).isoformat(timespec="seconds")


def slugify(text: str, fallback: str = "change") -> str:
    text = (text or "").strip().lower()
    text = re.sub(r"\s+", "-", text)
    text = re.sub(r"[^a-z0-9._-]+", "-", text)
    text = re.sub(r"-+", "-", text).strip("-._")
    return (text[:64] or fallback)


def extract_commit_message_from_args(commit_args: Sequence[str]) -> Optional[str]:
    messages: List[str] = []
    i = 0
    args = list(commit_args)
    while i < len(args):
        token = args[i]
        if token in {"-m", "--message"}:
            if i + 1 < len(args):
                messages.append(args[i + 1])
                i += 2
                continue
        if token.startswith("--message="):
            messages.append(token.split("=", 1)[1])
            i += 1
            continue
        if token in {"-F", "--file"}:
            if i + 1 < len(args):
                file_path = args[i + 1]
                try:
                    messages.append(pathlib.Path(file_path).read_text(encoding="utf-8").strip())
                except OSError:
                    pass
                i += 2
                continue
        if token.startswith("-F") and token != "-F" and len(token) > 2:
            try:
                messages.append(pathlib.Path(token[2:]).read_text(encoding="utf-8").strip())
            except OSError:
                pass
            i += 1
            continue
        if token.startswith("-") and not token.startswith("--") and len(token) > 2:
            flags = token[1:]
            if "m" in flags and flags[-1] == "m" and i + 1 < len(args):
                messages.append(args[i + 1])
                i += 2
                continue
            if flags.startswith("m") and len(flags) > 1:
                messages.append(flags[1:])
                i += 1
                continue
            if flags.startswith("F") and len(flags) > 1:
                try:
                    messages.append(pathlib.Path(flags[1:]).read_text(encoding="utf-8").strip())
                except OSError:
                    pass
                i += 1
                continue
        i += 1
    if not messages:
        return None
    return "\n\n".join([m for m in messages if m is not None]).strip() or None


def commit_uses_all_flag(commit_args: Sequence[str]) -> bool:
    for token in commit_args:
        if token == "--all":
            return True
        if token.startswith("-") and not token.startswith("--") and len(token) > 1 and "a" in token[1:]:
            return True
    return False


def has_staged_changes(repo_root: pathlib.Path) -> bool:
    proc = git(repo_root, ["diff", "--cached", "--quiet"], check=False)
    return proc.returncode != 0


def ensure_tracked_dirs(repo_root: pathlib.Path) -> None:
    (repo_root / DOCS_DIR_REL).mkdir(parents=True, exist_ok=True)
    (repo_root / HOOKS_DIR_REL).mkdir(parents=True, exist_ok=True)


def parse_name_status(repo_root: pathlib.Path) -> List[ChangedFile]:
    out = git_out(repo_root, ["diff", "--cached", "--name-status", "-M"])
    files: List[ChangedFile] = []
    if not out:
        return files
    for line in out.splitlines():
        parts = line.split("\t")
        if not parts:
            continue
        status_raw = parts[0].strip()
        status = status_raw[:1] if status_raw else "M"
        if status == "R" and len(parts) >= 3:
            files.append(ChangedFile(status="R", old_path=parts[1], path=parts[2]))
        elif len(parts) >= 2:
            files.append(ChangedFile(status=status, path=parts[1]))
    return files


def apply_numstats(repo_root: pathlib.Path, files: List[ChangedFile]) -> Tuple[int, int]:
    out = git_out(repo_root, ["diff", "--cached", "--numstat"])
    totals = [0, 0]
    by_path: Dict[str, Tuple[Optional[int], Optional[int]]] = {}
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        add_s, del_s, path = parts[0], parts[1], parts[2]
        add_v = None if add_s == "-" else int(add_s)
        del_v = None if del_s == "-" else int(del_s)
        by_path[path] = (add_v, del_v)
        if add_v is not None:
            totals[0] += add_v
        if del_v is not None:
            totals[1] += del_v
    for f in files:
        key = f.path
        if f.status == "R" and key not in by_path and f.old_path and f.old_path in by_path:
            key = f.old_path
        if key in by_path:
            f.added, f.deleted = by_path[key]
    return totals[0], totals[1]


def top_level_dirs(paths: Sequence[str]) -> List[str]:
    counts: Dict[str, int] = {}
    for p in paths:
        first = p.split("/", 1)[0] if "/" in p else "."
        counts[first] = counts.get(first, 0) + 1
    return [k for k, _ in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))][:6]


def collect_staged_snapshot(repo_root: pathlib.Path) -> StagedSnapshot:
    files = parse_name_status(repo_root)
    added, deleted = apply_numstats(repo_root, files)
    diff_stat_text = git_out(repo_root, ["diff", "--cached", "--stat"]) if files else ""
    dirs = top_level_dirs([f.path for f in files])
    return StagedSnapshot(
        changed_files=files,
        diff_stat_text=diff_stat_text,
        total_added=added,
        total_deleted=deleted,
        file_count=len(files),
        top_dirs=dirs,
    )


def has_non_journal_changes(snapshot: StagedSnapshot) -> bool:
    for f in snapshot.changed_files:
        if not f.path.startswith("docs/changes/"):
            return True
    return False


def codex_home() -> pathlib.Path:
    env_home = os.environ.get("CODEX_HOME")
    if env_home:
        return pathlib.Path(env_home)
    return pathlib.Path.home() / ".codex"


def looks_like_noise_user_message(text: str) -> bool:
    t = text.strip()
    if not t:
        return True
    if t.startswith("# AGENTS.md instructions for "):
        return True
    if t.startswith("<environment_context>"):
        return True
    if "<INSTRUCTIONS>" in t and "AGENTS.md" in t and len(t) > 200:
        return True
    return False


def looks_like_noise_agent_message(text: str) -> bool:
    t = text.strip()
    if not t:
        return True
    if len(t) > 5000:
        return True
    if re.search(r"[A-Za-z0-9+/]{900,}={0,2}", t):
        return True
    return False


def normalize_message(text: str) -> str:
    t = text.replace("\r\n", "\n").strip()
    t = re.sub(r"\n{3,}", "\n\n", t)
    return t


def parse_iso_timestamp(ts: Optional[str]) -> Optional[dt.datetime]:
    if not ts:
        return None
    s = ts.strip()
    if not s:
        return None
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        parsed = dt.datetime.fromisoformat(s)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed


def command_looks_like_git_push_for_repo(cmd: str, repo_root: pathlib.Path) -> bool:
    c = cmd.strip()
    if not c:
        return False
    if not re.search(r"\bgit\b", c):
        return False
    if not re.search(r"\bpush\b", c):
        return False
    if not re.search(r"\bgit\b[\s\S]*\bpush\b", c):
        return False
    # If the command explicitly targets another repo with `git -C`, don't treat it as a boundary.
    if re.search(r"\bgit\s+-C\s+", c) and str(repo_root) not in c:
        return False
    return True


def function_call_output_succeeded(output_text: str) -> bool:
    t = output_text or ""
    if "Process exited with code 0" in t:
        return True
    if re.search(r'"exit_code"\s*:\s*0', t):
        return True
    return False


def extract_exec_command_candidates_from_function_call(payload: Dict[str, Any]) -> List[str]:
    cmds: List[str] = []
    if payload.get("type") != "function_call":
        return cmds
    name = str(payload.get("name") or "")
    raw_args = payload.get("arguments")
    if not isinstance(raw_args, str):
        return cmds
    try:
        args = json.loads(raw_args)
    except json.JSONDecodeError:
        return cmds

    if name == "exec_command" and isinstance(args, dict):
        cmd = args.get("cmd")
        if isinstance(cmd, str):
            cmds.append(cmd)
        return cmds

    if name == "parallel" and isinstance(args, dict):
        for item in args.get("tool_uses") or []:
            if not isinstance(item, dict):
                continue
            if item.get("recipient_name") != "functions.exec_command":
                continue
            params = item.get("parameters")
            if not isinstance(params, dict):
                continue
            cmd = params.get("cmd")
            if isinstance(cmd, str):
                cmds.append(cmd)
    return cmds


def session_matches_repo(session_cwd: str, repo_root: pathlib.Path) -> bool:
    try:
        sc = pathlib.Path(session_cwd).resolve()
        rr = repo_root.resolve()
    except OSError:
        return False
    return sc == rr or str(sc).startswith(str(rr) + os.sep)


def iter_recent_session_files(limit: int = 60) -> List[pathlib.Path]:
    sessions_root = codex_home() / "sessions"
    if not sessions_root.exists():
        return []
    files: List[Tuple[float, pathlib.Path]] = []
    for p in sessions_root.rglob("*.jsonl"):
        try:
            files.append((p.stat().st_mtime, p))
        except OSError:
            continue
    files.sort(key=lambda item: item[0], reverse=True)
    return [p for _, p in files[:limit]]


def parse_session_file_for_repo(path: pathlib.Path, repo_root: pathlib.Path, as_of: Optional[dt.datetime] = None) -> Optional[SessionContext]:
    session_id = ""
    session_ts: Optional[str] = None
    session_cwd = ""
    meta_seen = False
    timeline_messages: List[TimelineMessage] = []
    pending_push_call_ids: Dict[str, bool] = {}
    last_successful_push_ts: Optional[str] = None
    last_successful_push_dt: Optional[dt.datetime] = None
    as_of_dt = as_of.astimezone() if as_of else None
    try:
        with path.open("r", encoding="utf-8") as fh:
            for raw_line in fh:
                line = raw_line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                event_ts = obj.get("timestamp")
                event_ts_dt = parse_iso_timestamp(event_ts)
                if as_of_dt and event_ts_dt and event_ts_dt > as_of_dt:
                    continue
                typ = obj.get("type")
                payload = obj.get("payload") or {}
                if typ == "session_meta":
                    meta_seen = True
                    session_id = str(payload.get("id") or "")
                    session_ts = payload.get("timestamp")
                    session_cwd = str(payload.get("cwd") or "")
                    if not session_matches_repo(session_cwd, repo_root):
                        return None
                    continue
                if not meta_seen:
                    continue
                if typ == "event_msg":
                    ptype = payload.get("type")
                    if ptype == "user_message":
                        msg = normalize_message(str(payload.get("message") or ""))
                        if not looks_like_noise_user_message(msg):
                            timeline_messages.append(TimelineMessage(timestamp=event_ts, timestamp_dt=event_ts_dt, role="user", text=msg))
                    elif ptype == "agent_message":
                        msg = normalize_message(str(payload.get("message") or ""))
                        if not looks_like_noise_agent_message(msg):
                            timeline_messages.append(TimelineMessage(timestamp=event_ts, timestamp_dt=event_ts_dt, role="assistant", text=msg))
                elif typ == "response_item":
                    if payload.get("type") == "function_call":
                        call_id = str(payload.get("call_id") or "")
                        for cmd in extract_exec_command_candidates_from_function_call(payload):
                            if command_looks_like_git_push_for_repo(cmd, repo_root) and call_id:
                                pending_push_call_ids[call_id] = True
                    elif payload.get("type") == "function_call_output":
                        call_id = str(payload.get("call_id") or "")
                        if call_id and call_id in pending_push_call_ids:
                            if function_call_output_succeeded(str(payload.get("output") or "")):
                                last_successful_push_ts = str(event_ts or "")
                                last_successful_push_dt = event_ts_dt
                            pending_push_call_ids.pop(call_id, None)
                    if payload.get("type") == "message" and payload.get("role") == "user":
                        # fallback for sessions missing event_msg.user_message
                        texts: List[str] = []
                        for item in payload.get("content") or []:
                            if isinstance(item, dict) and item.get("type") in {"input_text", "output_text"}:
                                txt = normalize_message(str(item.get("text") or ""))
                                if txt:
                                    texts.append(txt)
                        joined = "\n\n".join(texts).strip()
                        if joined and not looks_like_noise_user_message(joined):
                            timeline_messages.append(TimelineMessage(timestamp=event_ts, timestamp_dt=event_ts_dt, role="user", text=joined))
        if not meta_seen or not session_cwd:
            return None

        boundary_dt = last_successful_push_dt
        boundary_ts = last_successful_push_ts or None
        window_reason = "after-last-successful-push" if boundary_dt else "session-start"

        filtered_messages: List[TimelineMessage] = []
        for item in timeline_messages:
            if boundary_dt and item.timestamp_dt and item.timestamp_dt <= boundary_dt:
                continue
            filtered_messages.append(item)

        user_msgs = [m.text for m in filtered_messages if m.role == "user"]
        agent_msgs = [m.text for m in filtered_messages if m.role == "assistant"]

        # de-duplicate while preserving order
        def dedupe(items: List[str]) -> List[str]:
            seen = set()
            out: List[str] = []
            for item in items:
                key = item.strip()
                if not key or key in seen:
                    continue
                seen.add(key)
                out.append(item)
            return out

        user_msgs = dedupe(user_msgs)
        agent_msgs = dedupe(agent_msgs)
        return SessionContext(
            session_id=session_id or path.stem,
            file_path=path,
            session_timestamp=session_ts,
            cwd=session_cwd,
            user_messages=user_msgs[-MAX_USER_MSGS:],
            agent_messages=agent_msgs[-MAX_AGENT_MSGS:],
            context_window_reason=window_reason,
            context_window_start_timestamp=boundary_ts or session_ts,
            context_window_end_timestamp=as_of_dt.isoformat(timespec="seconds") if as_of_dt else None,
            last_successful_push_timestamp=boundary_ts,
        )
    except OSError:
        return None


def load_recent_codex_context(repo_root: pathlib.Path, as_of: Optional[dt.datetime] = None) -> Optional[SessionContext]:
    for path in iter_recent_session_files():
        ctx = parse_session_file_for_repo(path, repo_root, as_of=as_of)
        if ctx:
            return ctx
    return None


def trim_lines(text: str, max_chars: int = 320) -> str:
    t = text.strip()
    if len(t) <= max_chars:
        return t
    return t[: max_chars - 1].rstrip() + "…"


def split_sentences_zh_aware(text: str) -> List[str]:
    chunks = re.split(r"(?<=[。！？!?])\s*|\n+", text)
    return [c.strip(" \t-•") for c in chunks if c.strip()]


def infer_why_lines(user_messages: Sequence[str], agent_messages: Sequence[str]) -> List[str]:
    patterns = [r"因为", r"为了", r"希望", r"痛点", r"问题", r"原因", r"避免", r"方便", r"忘", r"追溯"]
    results: List[str] = []
    for source in list(user_messages) + list(agent_messages):
        for sent in split_sentences_zh_aware(source):
            if any(re.search(p, sent) for p in patterns):
                results.append(trim_lines(sent, 180))
        if len(results) >= 4:
            break
    # de-dup
    out: List[str] = []
    seen = set()
    for line in results:
        if line not in seen:
            seen.add(line)
            out.append(line)
    return out[:4]


def extract_process_thoughts(agent_messages: Sequence[str]) -> List[str]:
    preferred: List[str] = []
    fallback: List[str] = []
    for msg in agent_messages:
        for sent in split_sentences_zh_aware(msg):
            s = trim_lines(sent, 200)
            if len(s) < 8:
                continue
            if re.search(r"先|然后|接着|方案|目标|原因|限制|验证|实现|落地|hook|wrapper|脚本", s, re.I):
                preferred.append(s)
            else:
                fallback.append(s)
    merged: List[str] = []
    seen = set()
    for seq in (preferred, fallback):
        for s in seq:
            if s in seen:
                continue
            seen.add(s)
            merged.append(s)
            if len(merged) >= 6:
                return merged
    return merged


def summarize_change_scope(snapshot: StagedSnapshot) -> List[str]:
    bullets: List[str] = []
    if snapshot.top_dirs:
        bullets.append(f"主要改动目录：{', '.join(snapshot.top_dirs)}")
    ext_counts: Dict[str, int] = {}
    for f in snapshot.changed_files:
        ext = pathlib.Path(f.path).suffix.lower() or "(noext)"
        ext_counts[ext] = ext_counts.get(ext, 0) + 1
    if ext_counts:
        top_exts = sorted(ext_counts.items(), key=lambda kv: (-kv[1], kv[0]))[:5]
        bullets.append("文件类型分布：" + ", ".join(f"{k} x{v}" for k, v in top_exts))
    statuses: Dict[str, int] = {}
    for f in snapshot.changed_files:
        statuses[f.status] = statuses.get(f.status, 0) + 1
    if statuses:
        order = ["A", "M", "R", "D"]
        pieces = [f"{k} x{statuses[k]}" for k in order if k in statuses]
        for k, v in sorted(statuses.items()):
            if k not in order:
                pieces.append(f"{k} x{v}")
        bullets.append("变更类型：" + ", ".join(pieces))
    bullets.append(f"暂存区统计：+{snapshot.total_added} / -{snapshot.total_deleted}，共 {snapshot.file_count} 个文件")
    return bullets


def format_changed_files(snapshot: StagedSnapshot) -> str:
    if not snapshot.changed_files:
        return "- (无暂存改动)"
    lines = []
    for f in snapshot.changed_files:
        delta = ""
        if f.added is not None or f.deleted is not None:
            add = "?" if f.added is None else str(f.added)
            delete = "?" if f.deleted is None else str(f.deleted)
            delta = f" (+{add} / -{delete})"
        if f.status == "R" and f.old_path:
            lines.append(f"- `[R]` `{f.old_path}` -> `{f.path}`{delta}")
        else:
            lines.append(f"- `[{f.status}]` `{f.path}`{delta}")
    return "\n".join(lines)


def pick_user_requirements(ctx: Optional[SessionContext]) -> List[str]:
    if not ctx:
        return []
    reqs: List[str] = []
    for msg in ctx.user_messages:
        for sent in split_sentences_zh_aware(msg):
            s = trim_lines(sent, 220)
            if len(s) < 4:
                continue
            if looks_like_noise_user_message(s):
                continue
            reqs.append(s)
    out: List[str] = []
    seen = set()
    for item in reqs:
        if item not in seen:
            seen.add(item)
            out.append(item)
    return out[-6:]


def quote_block(lines: Sequence[str]) -> str:
    if not lines:
        return "> (未提取到有效上下文)"
    return "\n".join([f"> {line.replace(chr(10), ' ')}" for line in lines])


def build_journal_markdown(
    repo_root: pathlib.Path,
    snapshot: StagedSnapshot,
    ctx: Optional[SessionContext],
    commit_message: Optional[str],
    generated_at: dt.datetime,
    mode: str,
) -> str:
    generated_iso = generated_at.isoformat(timespec="seconds")
    human_time = generated_at.strftime("%Y-%m-%d %H:%M:%S %z")
    subject = (commit_message or "(commit message 未提供；可能是原生 git commit/hook 模式)").strip()
    subject_first = subject.splitlines()[0].strip() if subject else "(empty)"
    user_requirements = pick_user_requirements(ctx)
    why_lines = infer_why_lines(ctx.user_messages if ctx else [], ctx.agent_messages if ctx else []) if ctx else []
    process_lines = extract_process_thoughts(ctx.agent_messages if ctx else []) if ctx else []
    change_scope = summarize_change_scope(snapshot)
    session_meta = []
    if ctx:
        session_meta.append(f"- Codex 会话文件：`{ctx.file_path}`")
        if ctx.session_id:
            session_meta.append(f"- 会话 ID：`{ctx.session_id}`")
        if ctx.session_timestamp:
            session_meta.append(f"- 会话开始时间：`{ctx.session_timestamp}`")
        if ctx.context_window_reason == "after-last-successful-push":
            session_meta.append(
                f"- 上下文截取范围：最近一次成功 `git push` 之后到本次文档生成前（起点：`{ctx.context_window_start_timestamp or 'unknown'}`，终点：`{ctx.context_window_end_timestamp or generated_iso}`）"
            )
        else:
            session_meta.append(
                f"- 上下文截取范围：当前会话开始到本次文档生成前（未检测到成功 `git push`，起点：`{ctx.context_window_start_timestamp or 'unknown'}`，终点：`{ctx.context_window_end_timestamp or generated_iso}`）"
            )
    else:
        session_meta.append("- 未找到匹配当前仓库的 Codex 会话日志（`~/.codex/sessions`）")

    excerpts: List[str] = []
    if ctx:
        for msg in user_requirements[-3:]:
            excerpts.append(f"用户：{msg}")
        for msg in process_lines[:3]:
            excerpts.append(f"AI：{msg}")

    header = [
        MARKER,
        f"<!-- mode: {mode} -->",
        f"<!-- generated_at: {generated_iso} -->",
        "",
        f"# AI 提交变更记录 - {generated_at.strftime('%Y-%m-%d %H:%M:%S')}",
        "",
        "## 元信息",
        f"- 文档生成时间：`{human_time}`",
        f"- 提交记录时间（近似，提交前生成）：`{human_time}`",
        f"- 提交时间（Git，committer）：`{GIT_COMMIT_TIME_PLACEHOLDER}`",
        f"- 提交方式：`{mode}`",
        f"- 提交说明（捕获）：`{subject_first}`",
        "- 提交哈希（Git）：同一提交内无法稳定自引用（写入会改变 hash），请通过 `git log -- docs/changes` 或对应提交查看",
        "",
        "## 这次改了什么（基于暂存区）",
        *[f"- {line}" if not line.startswith("主要") and not line.startswith("文件类型") and not line.startswith("变更类型") and not line.startswith("暂存区统计") else f"- {line}" for line in change_scope],
        "",
        "### 改动文件清单",
        format_changed_files(snapshot),
        "",
    ]

    body: List[str] = []
    body.extend([
        "## 需求是什么（基于 AI 对话上下文自动提取）",
    ])
    if user_requirements:
        body.extend([f"- {line}" for line in user_requirements])
    else:
        body.append("- 未提取到明确需求描述；本次记录仅包含代码改动信息。")
    body.append("")

    body.append("## 为什么要做（自动归纳/推断）")
    if why_lines:
        body.extend([f"- {line}" for line in why_lines])
    elif user_requirements:
        body.append("- 未在上下文中显式提到“原因/痛点”，可从上方需求描述推断业务动机。")
    else:
        body.append("- 无法归纳，缺少可用上下文。")
    body.append("")

    body.append("## 过程中的思考（AI 协作痕迹）")
    if process_lines:
        body.extend([f"- {line}" for line in process_lines])
    else:
        body.append("- 未提取到有效 AI 过程消息（可能本次不是在 Codex 中完成，或日志不可访问）。")
    body.append("")

    body.extend([
        "## AI 上下文来源",
        *session_meta,
        "",
        "## 上下文摘录（便于回看当时为什么这么做）",
        quote_block(excerpts[:MAX_EXCERPTS]),
        "",
        "## Diff 统计（git diff --cached --stat）",
        "```text",
        snapshot.diff_stat_text or "(empty)",
        "```",
        "",
        "## 备注",
        "- 本文档由 `scripts/ai_commit_journal.py` 自动生成。",
        "- Hook 模式下可能拿不到最终 commit message；推荐使用 `python3 scripts/ai_commit_journal.py commit -m \"...\"`。",
        "- 若 AI 上下文为空，请确认是在 Codex 中开发，且本机存在 `~/.codex/sessions`。",
        "",
    ])

    return "\n".join(header + body).rstrip() + "\n"


def write_journal_file(
    repo_root: pathlib.Path,
    markdown: str,
    commit_message: Optional[str],
    generated_at: dt.datetime,
) -> pathlib.Path:
    ensure_tracked_dirs(repo_root)
    date_dir = repo_root / DOCS_DIR_REL / generated_at.strftime("%Y") / generated_at.strftime("%m")
    date_dir.mkdir(parents=True, exist_ok=True)
    subject = (commit_message or "auto-journal").splitlines()[0].strip()
    fname_base = f"{generated_at.strftime('%Y%m%d-%H%M%S')}-{slugify(subject, fallback='auto-journal')}"
    path = date_dir / f"{fname_base}.md"
    suffix = 1
    while path.exists():
        path = date_dir / f"{fname_base}-{suffix}.md"
        suffix += 1
    path.write_text(markdown, encoding="utf-8")
    return path


def stage_file(repo_root: pathlib.Path, path: pathlib.Path) -> None:
    rel = path.relative_to(repo_root)
    git(repo_root, ["add", "--", str(rel)])


def generate_journal(repo_root: pathlib.Path, commit_message: Optional[str], mode: str, stage: bool) -> JournalDraft:
    if not has_staged_changes(repo_root):
        raise JournalError("No staged changes found. Please `git add` first (or use `git commit -a` via wrapper).")
    snapshot = collect_staged_snapshot(repo_root)
    if not has_non_journal_changes(snapshot):
        raise JournalError("Only docs/changes files are staged; skip auto journal generation to avoid recursive journals.")
    generated_at = now_local()
    ctx = load_recent_codex_context(repo_root, as_of=generated_at)
    markdown = build_journal_markdown(repo_root, snapshot, ctx, commit_message, generated_at, mode)
    path = write_journal_file(repo_root, markdown, commit_message, generated_at)
    if stage:
        stage_file(repo_root, path)
    subject_guess = (commit_message or "(unknown)").splitlines()[0].strip() if commit_message else "(unknown)"
    return JournalDraft(path=path, generated_at_iso=generated_at.isoformat(timespec="seconds"), commit_subject_guess=subject_guess)


def get_head_commit_info(repo_root: pathlib.Path) -> HeadCommitInfo:
    out = git_out(repo_root, ["show", "-s", "--format=%H%n%cI", "HEAD"])
    parts = out.splitlines()
    if len(parts) < 2:
        raise JournalError("Unable to read HEAD commit metadata")
    return HeadCommitInfo(commit_hash=parts[0].strip(), committer_time_iso=parts[1].strip())


def list_head_changed_journal_paths(repo_root: pathlib.Path) -> List[pathlib.Path]:
    out = git_out(repo_root, ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "HEAD", "--", "docs/changes"])
    paths: List[pathlib.Path] = []
    for line in out.splitlines():
        rel = line.strip()
        if not rel or not rel.endswith(".md"):
            continue
        path = repo_root / rel
        if path.exists():
            paths.append(path)
    return paths


def patch_journal_commit_metadata_in_file(path: pathlib.Path, info: HeadCommitInfo) -> bool:
    try:
        original = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise JournalError(f"Failed to read journal file: {path}") from exc
    if MARKER not in original:
        return False

    has_pending_commit_time = GIT_COMMIT_TIME_PLACEHOLDER in original
    if not has_pending_commit_time:
        # Only patch freshly generated journals that still contain the placeholder.
        return False

    updated = original
    updated = updated.replace(GIT_COMMIT_TIME_PLACEHOLDER, info.committer_time_iso)

    if updated == original:
        return False
    path.write_text(updated, encoding="utf-8")
    return True


def finalize_head_journal_commit_metadata(repo_root: pathlib.Path, amend: bool) -> int:
    info = get_head_commit_info(repo_root)
    journal_paths = list_head_changed_journal_paths(repo_root)
    changed_paths: List[pathlib.Path] = []
    for path in journal_paths:
        if patch_journal_commit_metadata_in_file(path, info):
            changed_paths.append(path)
    if not changed_paths:
        return 0
    for path in changed_paths:
        stage_file(repo_root, path)
    if amend:
        env = os.environ.copy()
        env["AI_COMMIT_JOURNAL_POST_COMMIT_RUNNING"] = "1"
        env["AI_COMMIT_JOURNAL_NOOP_HOOK"] = "1"
        env["GIT_COMMITTER_DATE"] = info.committer_time_iso
        proc = subprocess.run(["git", "commit", "--amend", "--no-edit", "--no-verify"], cwd=str(repo_root), env=env)
        if proc.returncode != 0:
            raise JournalError("Failed to amend commit after backfilling Git commit metadata in journal")
    return len(changed_paths)


def ensure_precommit_hook_template(repo_root: pathlib.Path) -> pathlib.Path:
    ensure_tracked_dirs(repo_root)
    hook_path = repo_root / PRECOMMIT_HOOK_REL
    hook_text = """#!/bin/sh
set -e

if [ \"${AI_COMMIT_JOURNAL_NOOP_HOOK:-}\" = \"1\" ]; then
  exit 0
fi

repo_root=$(git rev-parse --show-toplevel 2>/dev/null || true)
if [ -z \"$repo_root\" ]; then
  exit 0
fi

if [ \"${AI_COMMIT_JOURNAL_WRAPPER:-}\" = \"1\" ]; then
  # Wrapper mode already generated and staged the journal file.
  exit 0
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo \"ai-commit-journal: python3 not found\" >&2
  exit 1
fi

python3 \"$repo_root/scripts/ai_commit_journal.py\" hook-pre-commit
"""
    hook_path.write_text(hook_text, encoding="utf-8")
    hook_path.chmod(0o755)
    return hook_path


def ensure_postcommit_hook_template(repo_root: pathlib.Path) -> pathlib.Path:
    ensure_tracked_dirs(repo_root)
    hook_path = repo_root / POSTCOMMIT_HOOK_REL
    hook_text = """#!/bin/sh
set -e

if [ "${AI_COMMIT_JOURNAL_NOOP_HOOK:-}" = "1" ]; then
  exit 0
fi

if [ "${AI_COMMIT_JOURNAL_POST_COMMIT_RUNNING:-}" = "1" ]; then
  exit 0
fi

repo_root=$(git rev-parse --show-toplevel 2>/dev/null || true)
if [ -z "$repo_root" ]; then
  exit 0
fi

if ! command -v python3 >/dev/null 2>&1; then
  exit 0
fi

python3 "$repo_root/scripts/ai_commit_journal.py" hook-post-commit
"""
    hook_path.write_text(hook_text, encoding="utf-8")
    hook_path.chmod(0o755)
    return hook_path


def install_hooks(repo_root: pathlib.Path) -> None:
    pre_hook = ensure_precommit_hook_template(repo_root)
    post_hook = ensure_postcommit_hook_template(repo_root)
    git(repo_root, ["config", "core.hooksPath", str(HOOKS_DIR_REL)])
    print(f"Installed git hooksPath -> {HOOKS_DIR_REL}")
    print(f"Hook file: {pre_hook}")
    print(f"Hook file: {post_hook}")


def command_generate(args: argparse.Namespace) -> int:
    repo_root = get_repo_root()
    draft = generate_journal(repo_root, commit_message=args.message, mode=args.mode, stage=not args.no_stage)
    print(draft.path)
    return 0


def command_hook_pre_commit(_args: argparse.Namespace) -> int:
    repo_root = get_repo_root()
    try:
        draft = generate_journal(repo_root, commit_message=None, mode="hook-pre-commit", stage=True)
    except JournalError as exc:
        # If there are no staged changes, let git continue (some workflows rely on other hooks).
        if "No staged changes found" in str(exc) or "Only docs/changes files are staged" in str(exc):
            return 0
        eprint(f"ai-commit-journal: {exc}")
        return 1
    print(f"ai-commit-journal: staged journal -> {draft.path.relative_to(repo_root)}")
    return 0


def command_hook_post_commit(_args: argparse.Namespace) -> int:
    repo_root = get_repo_root()
    try:
        changed_count = finalize_head_journal_commit_metadata(repo_root, amend=True)
    except JournalError as exc:
        eprint(f"ai-commit-journal: {exc}")
        return 1
    if changed_count > 0:
        print(f"ai-commit-journal: backfilled git commit metadata in {changed_count} journal file(s)")
    return 0


def command_commit(args: argparse.Namespace) -> int:
    repo_root = get_repo_root()
    commit_args = list(args.git_args)

    if commit_uses_all_flag(commit_args):
        git(repo_root, ["add", "-u"])

    commit_message = extract_commit_message_from_args(commit_args)

    try:
        draft = generate_journal(repo_root, commit_message=commit_message, mode="wrapper", stage=True)
    except JournalError as exc:
        if "Only docs/changes files are staged" in str(exc):
            env = os.environ.copy()
            env["AI_COMMIT_JOURNAL_WRAPPER"] = "1"
            proc = subprocess.run(["git", "commit", *commit_args], cwd=str(repo_root), env=env)
            return proc.returncode
        eprint(f"ai-commit-journal: {exc}")
        return 1

    env = os.environ.copy()
    env["AI_COMMIT_JOURNAL_WRAPPER"] = "1"
    env["AI_COMMIT_JOURNAL_DOC_PATH"] = str(draft.path)
    proc = subprocess.run(["git", "commit", *commit_args], cwd=str(repo_root), env=env)
    if proc.returncode != 0:
        eprint("ai-commit-journal: git commit failed; journal file remains in working tree/staging area for inspection.")
        eprint(f"ai-commit-journal: journal path -> {draft.path}")
        return proc.returncode

    print(f"ai-commit-journal: journal committed -> {draft.path.relative_to(repo_root)}")
    return 0


def command_install_hooks(_args: argparse.Namespace) -> int:
    repo_root = get_repo_root()
    install_hooks(repo_root)
    return 0


def command_init(_args: argparse.Namespace) -> int:
    repo_root = get_repo_root()
    ensure_tracked_dirs(repo_root)
    readme = repo_root / DOCS_DIR_REL / "README.md"
    if not readme.exists():
        readme.write_text(
            "# AI Commit Journal\\n\\n由 `scripts/ai_commit_journal.py` 自动生成每次提交的变更说明文档。\\n",
            encoding="utf-8",
        )
    print(f"Initialized {DOCS_DIR_REL}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Generate AI-assisted commit journal documents from staged diff + Codex session logs.")
    sub = parser.add_subparsers(dest="command", required=True)

    p_commit = sub.add_parser("commit", help="Wrapper around git commit that auto-generates docs/changes journal")
    p_commit.add_argument("git_args", nargs=argparse.REMAINDER, help="Arguments passed to `git commit` (prefix with --)")
    p_commit.set_defaults(func=command_commit)

    p_generate = sub.add_parser("generate", help="Generate journal file from staged changes")
    p_generate.add_argument("--message", help="Commit message to embed in the journal")
    p_generate.add_argument("--mode", default="manual-generate", help="Mode label written into the journal")
    p_generate.add_argument("--no-stage", action="store_true", help="Do not git add the generated file")
    p_generate.set_defaults(func=command_generate)

    p_hook = sub.add_parser("hook-pre-commit", help=argparse.SUPPRESS)
    p_hook.set_defaults(func=command_hook_pre_commit)

    p_post = sub.add_parser("hook-post-commit", help=argparse.SUPPRESS)
    p_post.set_defaults(func=command_hook_post_commit)

    p_install = sub.add_parser("install-hooks", help="Create .githooks/pre-commit and .githooks/post-commit, then set git core.hooksPath")
    p_install.set_defaults(func=command_install_hooks)

    p_init = sub.add_parser("init", help="Create docs/changes directory if missing")
    p_init.set_defaults(func=command_init)

    return parser


def main() -> int:
    try:
        parser = build_parser()
        args = parser.parse_args()
        git_args = getattr(args, "git_args", None)
        if isinstance(git_args, list) and git_args and git_args[0] == "--":
            args.git_args = git_args[1:]
        return args.func(args)
    except JournalError as exc:
        eprint(f"ai-commit-journal: {exc}")
        return 1
    except KeyboardInterrupt:
        eprint("ai-commit-journal: interrupted")
        return 130


if __name__ == "__main__":
    sys.exit(main())
