#!/usr/bin/env bash
# Benchmark: builds a room from each local/bench/runs/<name>/photo.jpg on this PC (Meta calls, about $0.10 a room,
# $0.45 with painted walls) and appends one line per room to local/bench/results.jsonl. A folder ending in -painted
# asks Muse Image for the three other walls. Rooms already in results.jsonl are skipped, so a rerun resumes; a room
# stopped by a spend cap or a crash leaves no line.
# usage: bash scripts/bench.sh   (from the repo's root; sets its own two-hour spend window)
set -uo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
export META_SPEND_UNTIL=$(date -u -d '+2 hours' +%FT%TZ)
RUNS=local/bench/runs OUT=local/bench/results.jsonl
touch "$OUT"
for dir in "$RUNS"/*/; do
  name=$(basename "$dir")
  grep -q "\"name\": *\"bench-$name\"" "$OUT" && continue
  paint=0; [[ $name == *-painted ]] && paint=3
  echo "== $name (paint $paint)"
  rm -f "local/try/bench-$name.json"
  timeout 900 npx tsx server/try.ts "$dir/photo.jpg" --paint-walls $paint --name "bench-$name" 2>&1 | tail -3
  python3 - "local/try/bench-$name.json" "$OUT" "$name" <<'PY'
import json, sys
f, out, name = sys.argv[1:]
try: r = json.load(open(f))
except FileNotFoundError: sys.exit(print("   no result (spend cap or crash): not recorded, a rerun tries it again"))
row = {"name": f"bench-{name}", "stage": r["stage"], "refused": r.get("refused"), "usd": r.get("usd"), "s": round((r.get("ms") or 0) / 1000),
       "rewrites": max(0, len(r["attempts"]) - 1), "issues": [a["issues"] for a in r["attempts"]]}
open(out, "a").write(json.dumps(row) + "\n")
PY
done
echo "bench done: $(wc -l < "$OUT") rooms"
