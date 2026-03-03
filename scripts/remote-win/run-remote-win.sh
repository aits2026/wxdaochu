#!/usr/bin/env bash
set -euo pipefail

WIN_HOST="${WIN_HOST:-}"
WIN_USER="${WIN_USER:-}"
WIN_PORT="${WIN_PORT:-22}"
MAC_ROOT="${MAC_ROOT:-/Users/tison}"
WIN_ROOT="${WIN_ROOT:-C:\\}"
LOCAL_PROJECT_DIR="${LOCAL_PROJECT_DIR:-$(pwd -P)}"
WIN_PROJECT_REL="${WIN_PROJECT_REL:-}"
WIN_REPO_DIR="${WIN_REPO_DIR:-}"
WIN_BRANCH="${WIN_BRANCH:-}"
WIN_COMMAND="${WIN_COMMAND:-npm run build}"
WIN_LOG_ROOT="${WIN_LOG_ROOT:-C:\\codex-logs\\codex-remote}"
WIN_SKIP_INSTALL="${WIN_SKIP_INSTALL:-0}"
WIN_SKIP_GIT="${WIN_SKIP_GIT:-0}"
LOCAL_LOG_ROOT="${LOCAL_LOG_ROOT:-}"

if [[ -z "${WIN_HOST}" || -z "${WIN_USER}" ]]; then
  cat <<'EOF'
usage:
  WIN_HOST=192.168.1.23 WIN_USER=your-user bash scripts/remote-win/run-remote-win.sh

mapping defaults:
  LOCAL_PROJECT_DIR under MAC_ROOT (/Users/tison)
  maps to WIN_ROOT (C:\)
  example: /Users/tison/wxdaochu -> C:\wxdaochu

optional env:
  WIN_PORT=22
  MAC_ROOT='/Users/tison'
  WIN_ROOT='C:\'
  LOCAL_PROJECT_DIR='/Users/tison/some-project'
  WIN_PROJECT_REL='some-project'     # overrides auto relative path
  WIN_REPO_DIR='C:\some-project'     # highest priority
  WIN_COMMAND='npm run build'
  WIN_BRANCH='feature/abc'           # default: local current git branch
  WIN_SKIP_GIT=1                     # skip git fetch/switch/pull on Windows
  WIN_SKIP_INSTALL=1                 # skip npm ci on Windows
  WIN_LOG_ROOT='C:\codex-logs\codex-remote'
  LOCAL_LOG_ROOT='logs/remote-win'
EOF
  exit 1
fi

if [[ $# -gt 0 ]]; then
  WIN_COMMAND="$*"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_PS_PATH="${SCRIPT_DIR}/run-on-windows.ps1"
if [[ ! -f "${RUNNER_PS_PATH}" ]]; then
  echo "runner script not found: ${RUNNER_PS_PATH}" >&2
  exit 1
fi

MAC_ROOT="${MAC_ROOT%/}"
LOCAL_PROJECT_DIR="${LOCAL_PROJECT_DIR%/}"
if [[ -z "${LOCAL_LOG_ROOT}" ]]; then
  LOCAL_LOG_ROOT="${LOCAL_PROJECT_DIR}/logs/remote-win"
fi

trim_win_root() {
  local root="$1"
  while [[ "${root}" == *\\ || "${root}" == */ ]]; do
    root="${root%\\}"
    root="${root%/}"
  done
  printf "%s" "${root}"
}

to_win_path_fragment() {
  local p="$1"
  p="${p#/}"
  p="${p%/}"
  printf "%s" "${p//\//\\}"
}

if [[ -z "${WIN_REPO_DIR}" ]]; then
  rel_path="${WIN_PROJECT_REL}"
  if [[ -z "${rel_path}" ]]; then
    if [[ "${LOCAL_PROJECT_DIR}" == "${MAC_ROOT}" ]]; then
      echo "LOCAL_PROJECT_DIR points to MAC_ROOT. Please enter a project dir or set WIN_REPO_DIR." >&2
      exit 1
    fi
    if [[ "${LOCAL_PROJECT_DIR}" != "${MAC_ROOT}/"* ]]; then
      echo "LOCAL_PROJECT_DIR is outside MAC_ROOT. Please set WIN_REPO_DIR or WIN_PROJECT_REL." >&2
      echo "LOCAL_PROJECT_DIR=${LOCAL_PROJECT_DIR}" >&2
      echo "MAC_ROOT=${MAC_ROOT}" >&2
      exit 1
    fi
    rel_path="${LOCAL_PROJECT_DIR#${MAC_ROOT}/}"
  fi

  win_root_trimmed="$(trim_win_root "${WIN_ROOT}")"
  rel_win="$(to_win_path_fragment "${rel_path}")"
  WIN_REPO_DIR="${win_root_trimmed}\\${rel_win}"
fi

if [[ "${WIN_SKIP_GIT}" != "1" && -z "${WIN_BRANCH}" ]]; then
  if git -C "${LOCAL_PROJECT_DIR}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    WIN_BRANCH="$(git -C "${LOCAL_PROJECT_DIR}" rev-parse --abbrev-ref HEAD | tr -d '\r\n')"
    if [[ -z "${WIN_BRANCH}" || "${WIN_BRANCH}" == "HEAD" ]]; then
      echo "cannot detect local git branch from ${LOCAL_PROJECT_DIR}" >&2
      echo "set WIN_BRANCH manually or set WIN_SKIP_GIT=1" >&2
      exit 1
    fi
  else
    echo "${LOCAL_PROJECT_DIR} is not a git repository." >&2
    echo "set WIN_BRANCH manually or set WIN_SKIP_GIT=1" >&2
    exit 1
  fi
fi

mkdir -p "${LOCAL_LOG_ROOT}"
LOCAL_RUN_DIR="${LOCAL_LOG_ROOT}/$(date '+%Y%m%d-%H%M%S')"
mkdir -p "${LOCAL_RUN_DIR}"

escape_ps_literal() {
  local raw="$1"
  printf "%s" "${raw//\'/\'\'}"
}

encode_ps() {
  local ps="$1"
  printf "%s" "${ps}" | iconv -f UTF-8 -t UTF-16LE | base64 | tr -d '\n'
}

RUNNER_PS_B64="$(base64 < "${RUNNER_PS_PATH}" | tr -d '\n')"
REPO_ESCAPED="$(escape_ps_literal "${WIN_REPO_DIR}")"
COMMAND_ESCAPED="$(escape_ps_literal "${WIN_COMMAND}")"
LOG_ROOT_ESCAPED="$(escape_ps_literal "${WIN_LOG_ROOT}")"

RUNNER_ARGS="-RepoDir '${REPO_ESCAPED}' -Command '${COMMAND_ESCAPED}' -LogRoot '${LOG_ROOT_ESCAPED}'"
if [[ "${WIN_SKIP_GIT}" != "1" ]]; then
  BRANCH_ESCAPED="$(escape_ps_literal "${WIN_BRANCH}")"
  RUNNER_ARGS="${RUNNER_ARGS} -Branch '${BRANCH_ESCAPED}'"
else
  RUNNER_ARGS="${RUNNER_ARGS} -SkipGit"
fi
if [[ "${WIN_SKIP_INSTALL}" == "1" ]]; then
  RUNNER_ARGS="${RUNNER_ARGS} -SkipInstall"
fi

RUNNER_B64_ESCAPED="$(escape_ps_literal "${RUNNER_PS_B64}")"
RUN_PS="
\$ErrorActionPreference='Stop'
\$scriptB64='${RUNNER_B64_ESCAPED}'
\$scriptPath = Join-Path \$env:TEMP 'codex-run-on-windows.ps1'
[System.IO.File]::WriteAllBytes(\$scriptPath, [System.Convert]::FromBase64String(\$scriptB64))
try {
  & \$scriptPath ${RUNNER_ARGS}
}
finally {
  Remove-Item -LiteralPath \$scriptPath -Force -ErrorAction SilentlyContinue
}
"
RUN_ENCODED="$(encode_ps "${RUN_PS}")"

REMOTE="${WIN_USER}@${WIN_HOST}"
SSH_BASE=(ssh -p "${WIN_PORT}" "${REMOTE}")

echo "LOCAL_PROJECT_DIR=${LOCAL_PROJECT_DIR}"
echo "WIN_REPO_DIR=${WIN_REPO_DIR}"
if [[ -n "${WIN_BRANCH}" ]]; then
  echo "BRANCH=${WIN_BRANCH}"
fi
echo "==> Trigger Windows task on ${REMOTE}"

set +e
RUN_OUTPUT="$("${SSH_BASE[@]}" "powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${RUN_ENCODED}" 2>&1)"
RUN_EXIT=$?
set -e

printf "%s\n" "${RUN_OUTPUT}"

RUN_DIR="$(printf "%s\n" "${RUN_OUTPUT}" | awk -F= '/^RUN_DIR=/{print $2}' | tail -n1 | tr -d '\r')"
STATUS="$(printf "%s\n" "${RUN_OUTPUT}" | awk -F= '/^STATUS=/{print $2}' | tail -n1 | tr -d '\r')"

fetch_remote_file() {
  local remote_file="$1"
  local local_file="$2"
  local remote_escaped
  local fetch_ps
  local fetch_encoded

  remote_escaped="$(escape_ps_literal "${remote_file}")"
  fetch_ps="
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
if (Test-Path -LiteralPath '${remote_escaped}') {
  Get-Content -LiteralPath '${remote_escaped}' -Raw
}
"
  fetch_encoded="$(encode_ps "${fetch_ps}")"

  set +e
  "${SSH_BASE[@]}" "powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${fetch_encoded}" > "${local_file}" 2>/dev/null
  local code=$?
  set -e
  return "${code}"
}

if [[ -n "${RUN_DIR}" ]]; then
  fetch_remote_file "${RUN_DIR}\\run.log" "${LOCAL_RUN_DIR}/run.log" || true
  fetch_remote_file "${RUN_DIR}\\command.log" "${LOCAL_RUN_DIR}/command.log" || true
  fetch_remote_file "${RUN_DIR}\\summary.json" "${LOCAL_RUN_DIR}/summary.json" || true
fi

echo "LOCAL_LOG_DIR=${LOCAL_RUN_DIR}"

if [[ "${RUN_EXIT}" -ne 0 || "${STATUS}" == "failed" ]]; then
  exit 1
fi
