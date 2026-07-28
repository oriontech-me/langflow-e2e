#!/usr/bin/env bash
# Background write pressure against one Langflow instance, so a UI action can be
# performed inside the #965 contention window. Creates and deletes throwaway
# projects until killed; leftovers are purged by the caller.
BASE=${BASE:-http://localhost:7862}
P=${1:-6}
TOK=$(curl -s "$BASE/api/v1/auto_login" | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')
export TOK BASE
worker() {
  while :; do
    id=$(curl -s -X POST "$BASE/api/v1/projects/" -H "Authorization: Bearer $TOK" \
      -H 'Content-Type: application/json' -d "{\"name\":\"SAB965 $1-$RANDOM\"}" \
      | python3 -c 'import sys,json;print(json.load(sys.stdin).get("id",""))' 2>/dev/null)
    [ -n "$id" ] && curl -s -o /dev/null -X DELETE "$BASE/api/v1/projects/$id" -H "Authorization: Bearer $TOK"
  done
}
export -f worker
seq 1 "$P" | xargs -P "$P" -I{} bash -c 'worker {}'
