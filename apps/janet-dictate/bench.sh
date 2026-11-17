#!/usr/bin/env bash
# Generates 20 TTS utterances with `say` (writes files, plays nothing) and runs the
# in-process benchmark. Usage: bench.sh [path-to-janet-dictate] [--realtime]
set -euo pipefail
BIN="${1:-.build/release/janet-dictate}"
MODE="${2:-}"
DIR="$(mktemp -d)"
trap 'rm -rf "$DIR"' EXIT

cat > "$DIR/refs.txt" <<'TEXTS'
Remind me to email the professor about the lab report tomorrow morning.
What time does the career fair start on Thursday?
Add milk, eggs and coffee to the grocery list.
The quick brown fox jumps over the lazy dog.
Turn off the bedroom lights in ten minutes.
Send a message to Eli saying I am running five minutes late.
How long will it take to drive to Saint Louis right now?
Open the pull request and summarize the review comments.
I think we should move the meeting to next Wednesday at three.
Please schedule a dentist appointment for the second week of December.
The server restarted twice last night because the disk was full.
Can you check whether the backup finished successfully?
My flight leaves at six forty five in the evening.
Write a short thank you note to the recruiter from yesterday.
The temperature outside is forty two degrees and it is raining.
Let's order two large pizzas, one cheese and one pepperoni.
Play some quiet music while I finish this homework.
What is the capital of Australia?
Set a timer for twenty five minutes.
I need to pick up my package before the mail room closes.
TEXTS

i=0
while IFS= read -r line; do
	say -v Samantha -o "$DIR/$i.wav" --data-format=LEI16@16000 "$line"
	i=$((i + 1))
done < "$DIR/refs.txt"

if [ "$MODE" = "--realtime" ]; then
	"$BIN" --bench "$DIR" --realtime
else
	"$BIN" --bench "$DIR"
fi
