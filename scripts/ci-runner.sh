#!/usr/bin/env bash
# Register a self-hosted Actions runner for this repo on demand, in the macos-27
# Lima VM on far-star, and remove it again when done.
#
# The VM already runs the blakeports macOS_27 runner from /opt/actions-runner
# (managed by ghrunnerd). This script adds a second, separate agent in
# ~/actions-runner-obsidianghost inside the same VM, registered to
# trodemaster/obsidianghost as macOS_27-obsidianghost with the macOS_27 label
# that .github/workflows/ci.yml asks for. It never touches the blakeports runner.
#
#   scripts/ci-runner.sh up [--once]   start the VM if needed, register, start the agent
#   scripts/ci-runner.sh status        VM, GitHub registration, agent process
#   scripts/ci-runner.sh down [--force]  stop and deregister; power the VM off only if
#                                        `up` powered it on and no job is running there
#
# --once registers an ephemeral runner: it takes one job, then GitHub removes it.
# Needs, outside the Claude sandbox: ghrunnerd (VM power + exec), gh signed in to an
# account that administers this repo.
set -euo pipefail

REPO=trodemaster/obsidianghost
RUNNER_ID=macos-27                 # ghrunnerd id of the VM
BLAKEPORTS_RUNNER=macOS_27         # the VM's own runner (blakeports)
NAME=macOS_27-obsidianghost
LABELS=self-hosted,macOS,ARM64,macOS_27
GUEST_DIR='$HOME/actions-runner-obsidianghost'   # expanded in the guest
GHRUNNERD=${GHRUNNERD:-ghrunnerd}

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE="$ROOT/.cache/ci-runner"
STARTED_MARK="$STATE/started-vm"
cd "$ROOT"   # gh picks up this repo's credentials through direnv

die() { echo "ci-runner: $*" >&2; exit 1; }
log() { echo "ci-runner: $*" >&2; }

vm_running() {
  "$GHRUNNERD" status --json | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const r = JSON.parse(s).runners.find((x) => x.id === process.argv[1]);
      if (!r) { console.error("no runner " + process.argv[1] + " in ghrunnerd"); process.exit(2); }
      process.exit(r.vm_running ? 0 : 1);
    });' "$RUNNER_ID"
}

# blakeports runner busy? (a job there would die with the VM)
blakeports_busy() {
  "$GHRUNNERD" status --json | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const r = JSON.parse(s).runners.find((x) => x.id === process.argv[1]);
      process.exit(r && r.github && r.github.busy ? 0 : 1);
    });' "$RUNNER_ID"
}

# Our registration on GitHub: "<id> <status> <busy>", or nothing.
registration() {
  gh api "repos/$REPO/actions/runners" --paginate \
    --jq ".runners[] | select(.name == \"$NAME\") | \"\(.id) \(.status) \(.busy)\""
}

# Run a bash script in the guest: script text travels base64-encoded in the
# command line (no quoting issues), secrets travel on stdin.
guest() { # guest <script> <stdin> [args...]
  local script=$1 input=$2; shift 2
  local b64 args=""
  b64=$(printf '%s' "$script" | base64 | tr -d '\n')
  for a in "$@"; do args+=" '${a//\'/\'\\\'\'}'"; done
  printf '%s\n' "$input" | "$GHRUNNERD" exec --timeout 10m "$RUNNER_ID" -- \
    "bash -c \"\$(echo $b64 | base64 -d)\" ci-runner$args"
}

GUEST_UP='set -eu
read -r TOKEN
R='"$GUEST_DIR"'; URL=$1; NAME=$2; LABELS=$3; ONCE=$4
export PATH=/opt/local/bin:/opt/local/sbin:/usr/local/bin:$PATH
pkill -f "$R/bin/Runner.Listener" 2>/dev/null || true
if [ ! -x "$R/config.sh" ]; then
  [ -x /opt/actions-runner/config.sh ] || { echo "no /opt/actions-runner in the VM to copy the agent from" >&2; exit 1; }
  mkdir -p "$R"
  rsync -a --exclude _work --exclude _diag --exclude ".runner*" --exclude ".credentials*" \
    --exclude .service --exclude .env --exclude .path /opt/actions-runner/ "$R/"
fi
cd "$R"
rm -f .runner .runner_migrated .credentials .credentials_rsaparams
extra=""; [ "$ONCE" = 1 ] && extra=--ephemeral
./config.sh --url "$URL" --token "$TOKEN" --name "$NAME" --labels "$LABELS" \
  --work _work --unattended --replace $extra >/dev/null
nohup "$R/run.sh" </dev/null >"$R/run.log" 2>&1 &
echo "agent $(./config.sh --version) started as $NAME in $R"'

GUEST_DOWN='set -eu
read -r TOKEN
R='"$GUEST_DIR"'
[ -d "$R" ] || { echo "no agent directory"; exit 0; }
pkill -f "$R/run.sh" 2>/dev/null || true
pkill -f "$R/bin/Runner.Listener" 2>/dev/null || true
cd "$R"
if [ -f .runner ] && [ -n "$TOKEN" ]; then ./config.sh remove --token "$TOKEN" >/dev/null 2>&1 || true; fi
rm -f .runner .runner_migrated .credentials .credentials_rsaparams
echo "agent stopped"'

GUEST_STATUS='R='"$GUEST_DIR"'
if pgrep -f "$R/bin/Runner.Listener" >/dev/null; then echo "agent: running"; else echo "agent: not running"; fi
[ -f "$R/run.log" ] && tail -n 3 "$R/run.log" | sed "s/^/  /"
true'

cmd_up() {
  local once=0
  [ "${1:-}" = --once ] && once=1
  mkdir -p "$STATE"
  if vm_running; then
    log "$RUNNER_ID VM already running"
  else
    log "starting the $RUNNER_ID VM (this also brings up the blakeports $BLAKEPORTS_RUNNER runner)"
    "$GHRUNNERD" vm-start "$RUNNER_ID" >&2
    touch "$STARTED_MARK"
    for _ in $(seq 1 60); do
      "$GHRUNNERD" exec --timeout 15s "$RUNNER_ID" -- true >/dev/null 2>&1 && break
      sleep 5
    done
  fi
  local token
  token=$(gh api -X POST "repos/$REPO/actions/runners/registration-token" --jq .token)
  guest "$GUEST_UP" "$token" "https://github.com/$REPO" "$NAME" "$LABELS" "$once"
  for _ in $(seq 1 30); do
    if registration | grep -q ' online '; then
      log "$NAME is online for $REPO$([ $once = 1 ] && echo ' (one job)')"
      return 0
    fi
    sleep 2
  done
  die "$NAME did not come online; see: scripts/ci-runner.sh status"
}

cmd_down() {
  local force=0 reg id status busy
  [ "${1:-}" = --force ] && force=1
  reg=$(registration || true)
  if [ -n "$reg" ]; then
    read -r id status busy <<<"$reg"
    [ "$busy" = true ] && [ $force = 0 ] && die "$NAME is running a job; wait, or use --force"
  fi
  if vm_running; then
    local token
    token=$(gh api -X POST "repos/$REPO/actions/runners/remove-token" --jq .token)
    guest "$GUEST_DOWN" "$token"
  fi
  reg=$(registration || true)
  if [ -n "$reg" ]; then
    read -r id status busy <<<"$reg"
    gh api -X DELETE "repos/$REPO/actions/runners/$id" >/dev/null
    log "removed $NAME from $REPO"
  fi
  if [ -f "$STARTED_MARK" ] && vm_running; then
    if blakeports_busy; then
      log "leaving the VM on: the blakeports $BLAKEPORTS_RUNNER runner is running a job"
      return 0
    fi
    log "powering off the $RUNNER_ID VM (started by ci-runner up)"
    "$GHRUNNERD" vm-stop "$RUNNER_ID" >&2
  fi
  rm -f "$STARTED_MARK"
}

cmd_status() {
  if vm_running; then echo "VM $RUNNER_ID: running$([ -f "$STARTED_MARK" ] && echo ' (started by ci-runner up)')"
  else echo "VM $RUNNER_ID: stopped"; fi
  local reg
  reg=$(registration || true)
  if [ -n "$reg" ]; then
    read -r id status busy <<<"$reg"
    echo "GitHub: $NAME $status, busy=$busy (runner id $id)"
  else
    echo "GitHub: $NAME not registered"
  fi
  vm_running && guest "$GUEST_STATUS" ""
  true
}

case "${1:-}" in
  up) shift; cmd_up "$@" ;;
  down) shift; cmd_down "$@" ;;
  status) cmd_status ;;
  *) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
