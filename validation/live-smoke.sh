#!/usr/bin/env bash
#
# Live-path proof: drive a REAL Task through the public HAPI R5 server, the same
# server the browser "Live" toggle talks to. POSTs the demo's Task, captures the
# server-assigned id, GETs it back, and prints the public URL + HTTP statuses.
#
# This is the anti-vaporware evidence: a skeptic can run this (or open the URL it
# prints) and see the very resource on a server we do not control.
#
# Usage:  ./validation/live-smoke.sh
# Needs:  node, curl, network access to https://hapi.fhir.org/baseR5
#
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE="https://hapi.fhir.org/baseR5"

echo "Exporting the demo's FHIR resources (awaited async store flow)…"
node "$ROOT/validation/dump.js" >/dev/null
[ -f "/tmp/apix-res/Task.json" ] || { echo "ERROR: /tmp/apix-res/Task.json not found"; exit 1; }

# The public HAPI server enforces referential integrity, but our prerequisite
# resources (MPD/Org/DocumentReference) are not (and need not be) created on it
# for this proof. Convert the Task's references to display-only (still valid R5:
# a Reference may carry only .display) so this stays a SINGLE, self-contained,
# real round-trip. In the browser's Live mode the references DO resolve, because
# the flow POSTs the Binaries + DocumentReferences + Organization first.
TASK_JSON="/tmp/apix-task-live.json"
node -e '
const fs=require("fs");
const t=JSON.parse(fs.readFileSync("/tmp/apix-res/Task.json","utf8"));
const flat=r=>{ if(r && r.reference){ r.display=r.display||r.reference.split("/").pop(); delete r.reference; } return r; };
if(t.focus) flat(t.focus);
if(t.requester) flat(t.requester);
if(t.owner) flat(t.owner);
if(Array.isArray(t.input)) t.input.forEach(i=>i.valueReference&&flat(i.valueReference));
if(Array.isArray(t.output)) t.output.forEach(o=>o.valueReference&&flat(o.valueReference));
fs.writeFileSync("/tmp/apix-task-live.json", JSON.stringify(t));
'

echo
echo "POST  $BASE/Task"
CREATE_HDRS="$(mktemp)"
CREATE_BODY="$(curl -sS -D "$CREATE_HDRS" \
  -H 'Content-Type: application/fhir+json' \
  -H 'Accept: application/fhir+json' \
  --data-binary @"$TASK_JSON" \
  "$BASE/Task")"
POST_STATUS="$(awk 'toupper($1) ~ /^HTTP/ { code=$2 } END { print code }' "$CREATE_HDRS")"
echo "  → HTTP $POST_STATUS"

# Server-assigned id: prefer the Location header, fall back to the response body.
ID="$(awk 'BEGIN{IGNORECASE=1} /^location:/ { print $2 }' "$CREATE_HDRS" \
  | sed -E 's#.*/Task/([^/]+)(/.*)?#\1#' | tr -d '\r' | head -n1)"
if [ -z "${ID:-}" ]; then
  ID="$(printf '%s' "$CREATE_BODY" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).id||"")}catch(e){}})')"
fi
[ -n "${ID:-}" ] || { echo "ERROR: could not determine server Task id"; echo "$CREATE_BODY" | head -c 800; exit 1; }

PUBLIC_URL="$BASE/Task/$ID"
echo
echo "GET   $PUBLIC_URL"
GET_STATUS="$(curl -sS -o /tmp/apix-task-readback.json -w '%{http_code}' \
  -H 'Accept: application/fhir+json' "$PUBLIC_URL")"
echo "  → HTTP $GET_STATUS"

echo
echo "------------------------------------------------------------------"
echo "  CREATE (POST):   HTTP $POST_STATUS"
echo "  READ-BACK (GET): HTTP $GET_STATUS"
echo "  Public Task URL: $PUBLIC_URL"
echo "  (open it in a browser — it lives on a server we do not control)"
echo "------------------------------------------------------------------"

rm -f "$CREATE_HDRS"
case "$POST_STATUS:$GET_STATUS" in
  201:200) exit 0 ;;
  *) echo "WARN: expected 201/200; got $POST_STATUS/$GET_STATUS"; exit 1 ;;
esac
