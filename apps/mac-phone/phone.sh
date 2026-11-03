#!/bin/bash
# Run by AudioStrokePhone.app in two phases:
#   phone.sh setup   pick server / backend / scenario via dialogs → ~/.config/audio-stroke/phone.last
#   phone.sh run     run the bundled conversation client (phone.cjs, built from cli/phone.ts) with that choice
# Mic and speaker come from SoX. Settings: ~/.config/audio-stroke/phone.env (SERVER=...).
# Logs: ~/Library/Logs/AudioStrokePhone/.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
# node from a version manager when it is not installed via brew (dev machines)
for d in "$HOME/.anyenv/envs/nodenv/shims" "$HOME/.nodenv/shims" "$HOME/.volta/bin" "$HOME/.nvm/versions/node"/*/bin; do
  [ -d "$d" ] && PATH="$PATH:$d"
done
RES="$(cd "$(dirname "$0")" && pwd)"
CFG="$HOME/.config/audio-stroke/phone.env"
LAST="$HOME/.config/audio-stroke/phone.last"
MODE="${1:-setup}"
LOGDIR="$HOME/Library/Logs/AudioStrokePhone"
mkdir -p "$LOGDIR" "$(dirname "$CFG")"
child=""
trap 'if [ -n "$child" ]; then kill "$child" 2>/dev/null; fi' EXIT TERM INT

for bin in node rec play; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "$bin が見つかりません。brew install node sox を実行してください。"
    exit 1
  fi
done

ask() { osascript -e "$1" 2>/dev/null; }

[ -f "$CFG" ] && . "$CFG"

if [ "$MODE" = "run" ]; then
  [ -f "$LAST" ] && . "$LAST"
  if [ -z "$SERVER" ] || [ -z "$BACKEND" ] || [ -z "$SCENARIO" ]; then echo "選択が未完了です。「選び直す」を押してください。"; exit 1; fi
  LOG="$LOGDIR/phone-$(date +%Y%m%d-%H%M%S)-$BACKEND.jsonl"
  echo "server: $SERVER  backend: $BACKEND  scenario: $SCENARIO"
  echo "log: $LOG"
  echo "---- 会話開始。最初の案内が流れたら話してください（半二重: 再生中はマイク停止） ----"
  node "$RES/phone.cjs" --server "$SERVER" --scenario "$SCENARIO" --backend "$BACKEND" --log "$LOG" </dev/null &
  child=$!
  wait "$child"
  exit 0
fi

if [ -z "$SERVER" ]; then
  SERVER=$(ask 'text returned of (display dialog "サーバー URL" default answer "http://100.122.237.76:8000" with title "Audio Stroke Phone")')
  [ -z "$SERVER" ] && exit 0
  printf 'SERVER=%s\n' "$SERVER" > "$CFG"
fi
echo "server: $SERVER  (変更は $CFG)"

LIST=$(node "$RES/phone.cjs" --server "$SERVER" --list --json 2>&1) || { echo "$LIST"; exit 1; }

# pick: $1 = prompt, stdin = "id<TAB>label" lines → prints the chosen id.
# Choices are numbered in the dialog; the numbered list with ids is printed to the window (stderr) first.
pick() {
  local items="" first="" n=0 id label entry chosen idx
  local -a ids
  echo "== $1 ==" >&2
  while IFS=$'\t' read -r id label; do
    [ -z "$id" ] && continue
    n=$((n + 1)); ids[$n]="$id"
    entry="$n. ${label//\"/\'}"
    echo "  $entry  [$id]" >&2
    items="$items${items:+, }\"$entry\""
    [ -z "$first" ] && first="$entry"
  done
  chosen=$(ask "item 1 of (choose from list {$items} with prompt \"$1（詳細はアプリの画面に表示）\" default items {\"$first\"} with title \"Audio Stroke Phone\")")
  if [ -z "$chosen" ] || [ "$chosen" = "false" ]; then return 1; fi
  idx="${chosen%%.*}"
  printf '%s' "${ids[$idx]}"
}

# backend choice: "id<TAB>label"; backends with missing keys are listed but marked
BACKENDS=$(printf '%s' "$LIST" | node -e '
let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);
for(const o of j.backends){const miss=o.missing.length?"  [未設定: "+o.missing.join(", ")+"]":"";console.log(o.id+"\t"+o.id+(o.id===j.default?" (既定)":"")+"  "+o.detail+miss)}})')
BACKEND=$(printf '%s\n' "$BACKENDS" | pick "判定バックエンド") || exit 0

# scenario choice: title, READY version, first utterance
SCENARIOS=$(printf '%s' "$LIST" | node -e '
let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);
for(const s of j.scenarios){if(!s.ready.length)continue;const t=(s.title||"(無題)")+"  v"+Math.max(...s.ready)+"  「"+(s.first_utterance||"").slice(0,40)+"」";console.log(s.scenario_id+"\t"+t)}})')
if [ -z "$SCENARIOS" ]; then echo "READY なシナリオがありません。"; exit 1; fi
SCENARIO=$(printf '%s\n' "$SCENARIOS" | pick "シナリオ") || exit 0

printf 'BACKEND=%s\nSCENARIO=%s\n' "$BACKEND" "$SCENARIO" > "$LAST"
echo "選択: backend=$BACKEND  scenario=$SCENARIO"
