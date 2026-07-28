#!/usr/bin/env bash
# Timed variant: records HTTP status AND time_total for every DELETE, so a
# SQLITE_BUSY that ignores busy_timeout (instant failure) is distinguishable
# from one that waited out the 30 s timeout.
BASE=${BASE:-http://localhost:7860}
P=${1:-8}
N=${2:-10}
OUT=${3:-/tmp/scout965-timed.csv}
TOK=$(curl -s "$BASE/api/v1/auto_login" | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')
export TOK BASE N OUT
: > "$OUT"

worker() {
  w=$1
  for i in $(seq 1 "$N"); do
    id=$(curl -s -X POST "$BASE/api/v1/projects/" -H "Authorization: Bearer $TOK" \
      -H 'Content-Type: application/json' -d "{\"name\":\"Scout965T w$w-$i-$RANDOM\"}" \
      | python3 -c 'import sys,json;print(json.load(sys.stdin).get("id",""))' 2>/dev/null)
    [ -z "$id" ] && { echo "$w,$i,CREATE_FAIL,0,," >> "$OUT"; continue; }
    out=$(curl -s -w '\n%{http_code},%{time_total}' -X DELETE "$BASE/api/v1/projects/$id" -H "Authorization: Bearer $TOK")
    meta=$(printf '%s' "$out" | tail -1)
    body=$(printf '%s' "$out" | sed '$d' | tr -d '\n' | head -c 200)
    echo "$w,$i,$meta,$id,\"$body\"" >> "$OUT"
  done
}
export -f worker
seq 1 "$P" | xargs -P "$P" -I{} bash -c 'worker {}'
python3 - "$OUT" <<'PY'
import sys, csv
rows = list(csv.reader(open(sys.argv[1])))
ok = [r for r in rows if len(r) > 2 and r[2] == '204']
bad = [r for r in rows if len(r) > 2 and r[2] not in ('204',)]
def stat(rs):
    ts = [float(r[3]) for r in rs if len(r) > 3 and r[3] not in ('', '0')]
    return (min(ts), sum(ts)/len(ts), max(ts)) if ts else (0, 0, 0)
print(f"total={len(rows)} ok204={len(ok)} failed={len(bad)}")
print("ok   time_total  min/avg/max: %.2f / %.2f / %.2f s" % stat(ok))
print("fail time_total  min/avg/max: %.2f / %.2f / %.2f s" % stat(bad))
codes = {}
for r in bad:
    codes[r[2]] = codes.get(r[2], 0) + 1
print("failure codes:", codes)
PY
