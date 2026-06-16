#!/usr/bin/env bash
#
# Manually test Gamut's background-terminal notifications (issue #28).
#
# The sound/desktop notification fires only for a pane you are NOT looking at,
# so this script counts down first to give you time to switch away (another
# terminal tab, another group, or another app entirely). It then rings the
# terminal bell — the same "bell" event Claude Code and other CLIs emit to ask
# for attention.
#
# Usage:
#   ./scripts/notify-test.sh           # 5s countdown, then one bell
#   ./scripts/notify-test.sh 8         # 8s countdown
#   ./scripts/notify-test.sh 5 3       # 5s countdown, then 3 bells (2s apart)
#
# To test the OTHER trigger — process exit — just type `exit` in a background
# pane, or run:   sleep 5 && exit
#
set -u

delay="${1:-5}"
count="${2:-1}"

printf 'Gamut notification test\n'
printf '  → Switch AWAY from this pane now (another tab/group, or another app).\n'
printf '  → The focused pane is intentionally silent; only a background pane chimes.\n\n'
printf 'Ringing the bell in %ss' "$delay"

for ((i = delay; i > 0; i--)); do
  printf '.'
  sleep 1
done
printf '\n'

for ((b = 1; b <= count; b++)); do
  # \a is the terminal bell -> xterm.js onBell -> Gamut "bell" notification.
  printf '\a'
  printf 'bell %d/%d sent\n' "$b" "$count"
  # Space bells out past the 400ms coalescing window so each is a distinct cue.
  if ((b < count)); then sleep 2; fi
done

printf '\nDone. You should have heard the configured sound for each background bell.\n'
printf 'If you heard nothing: confirm the pane was NOT focused, and that\n'
printf 'Settings → Notifications → "Play sound on terminal events" + "Notify on\n'
printf 'terminal bell" are enabled. Use the Test button to check the sound itself.\n'
