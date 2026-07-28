#!/usr/bin/env bash
# Does a user ever SEE the #965 failure, or does a client-side retry hide it?
#
# The prior SQLite-lock finding in REGRESSIONS.md was downgraded to
# "non-user-facing robustness gap" because a client retry masked the 500. This
# loop tests that claim for the project-delete path: create a project via the
# API, delete it through the real UI while write contention runs, and classify
# the outcome by what the USER perceives — the toast, the notification centre,
# and whether the project is still there afterwards.
#
# Outcomes:
#   SUCCESS        — project gone, success toast (with or without a masked 500)
#   SILENT-FAILURE — project still there, no toast and no notification
#   VISIBLE-ERROR  — project still there, but the UI said so
BASE=${BASE:-http://localhost:7862}
N=${1:-8}
PW="npx --no-install playwright-cli"
TOK=$(curl -s "$BASE/api/v1/auto_login" | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')

for i in $(seq 1 "$N"); do
  name="ZZDEL$i"
  slug=$(printf '%s' "$name" | tr 'A-Z' 'a-z')
  id=$(curl -s -X POST "$BASE/api/v1/projects/" -H "Authorization: Bearer $TOK" \
    -H 'Content-Type: application/json' -d "{\"name\":\"$name\"}" \
    | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')

  $PW press Escape >/dev/null 2>&1
  $PW reload >/dev/null 2>&1
  sleep 2
  present=$($PW --raw eval "() => !!document.querySelector('[data-testid=\"more-options-button_$slug\"]')" 2>/dev/null | tr -d '\n ')
  if [ "$present" != "true" ]; then
    echo "iter $i | SKIPPED — row never rendered (list still loading under contention)"
    curl -s -o /dev/null -X DELETE "$BASE/api/v1/projects/$id" -H "Authorization: Bearer $TOK"
    continue
  fi

  # Each click needs the previous surface to be mounted: the row menu is a
  # Radix popover and the confirmation is a modal, so firing them back-to-back
  # silently no-ops (observed: 0 DELETE calls for 8 iterations).
  $PW click "getByTestId('more-options-button_$slug')" >/dev/null 2>&1
  sleep 1
  $PW click "getByTestId('btn-delete-project')" >/dev/null 2>&1
  sleep 1
  $PW click "getByTestId('btn_delete_delete_confirmation_modal')" >/dev/null 2>&1
  sleep 5

  calls=$($PW --raw requests 2>/dev/null | grep -c "DELETE.*projects/$id")
  fails=$($PW --raw requests 2>/dev/null | grep "DELETE.*projects/$id" | grep -c "500")
  feedback=$($PW --raw eval "() => document.body.innerText.split('\n').map(s=>s.trim()).filter(l => /deleted|error|wrong|fail/i.test(l)).slice(0,2).join(' / ')" 2>/dev/null | tr -d '\n' | sed 's/^\"//; s/\"$//')
  gone=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/v1/projects/$id" -H "Authorization: Bearer $TOK")

  if [ "$gone" = "404" ]; then
    verdict="SUCCESS$([ "$fails" -gt 0 ] && echo ' (500 masked by retry)')"
  elif [ -n "$feedback" ]; then
    verdict="VISIBLE-ERROR"
  else
    verdict="SILENT-FAILURE"
  fi
  echo "iter $i | $verdict | DELETE calls=$calls (500s=$fails) | GET after=$gone | ui text: ${feedback:-<none>}"
  [ "$gone" != "404" ] && curl -s -o /dev/null -X DELETE "$BASE/api/v1/projects/$id" -H "Authorization: Bearer $TOK"
done
