#!/usr/bin/env bash
#
# Seed the self-hosted HAPI R5 server with the APIX demo's foundation resources.
#
# Idempotent: every resource is PUT to a DETERMINISTIC id, so re-running just
# overwrites in place (no duplicates). Run AFTER the server is healthy:
#
#     docker compose up -d
#     # wait until `docker compose ps` shows (healthy)
#     ./seed.sh                 # uses http://localhost:8080/fhir by default
#     ./seed.sh http://my-host:8080/fhir   # or pass an explicit base
#
# What it loads (the "Connect"-time foundation the UI assumes already exists):
#   - 2 SubscriptionTopics  (status-change + create)
#   - 2 Organizations       (applicant SynthPharma AG + regulator Health Authority)
#   - 1 Endpoint            (notification webhook)
#   - product context       (MedicinalProductDefinition — Velexa)
#   - PQI spec Bundle        (PlanDefinition + ObservationDefinitions)
#
# The UI itself creates the Binaries / DocumentReferences / Task / Subscription
# at run time; this script only stages the shared, long-lived context.
#
# Needs: node (to emit resources from the JS data layer), curl, a running server.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BASE="${1:-http://localhost:8080/fhir}"
OUT="/tmp/apix-res"

echo "APIX seed → $BASE"
echo

# 1) Emit the canonical resources from the JS data layer (Bundle-pqi,
#    Organization-applicant, MedicinalProductDefinition, Endpoint,
#    SubscriptionTopic, Subscription, Task, DocumentReference).
echo "Exporting resources from the JS data layer…"
node "$ROOT/validation/dump.js" >/dev/null
[ -d "$OUT" ] || { echo "ERROR: $OUT not produced by dump.js"; exit 1; }

# 2) dump.js emits ONE Organization and ONE SubscriptionTopic. The server needs
#    BOTH organizations (applicant + regulator) and BOTH topics (status + create).
#    Emit the missing ones (regulator Org, create-topic) with their seed ids.
echo "Emitting regulator Organization + create-topic…"
node -e '
const fs=require("fs"), path=require("path");
const ROOT=process.argv[1], OUT=process.argv[2];
global.window=global;
global.CustomEvent=class extends Event{constructor(t,i){super(t);this.detail=i&&i.detail;}};
["highlight","codesystems","terminology","config","fhir-server","client","seed","pqi","sign","scenario","store"]
  .forEach(f=>eval(fs.readFileSync(path.join(ROOT,"js",f+".js"),"utf8")));
const w=(n,o)=>fs.writeFileSync(path.join(OUT,n+".json"),JSON.stringify(o,null,2));
w("Organization-regulator", APIX.seed.regulator);
w("SubscriptionTopic-create", APIX.seed.topicCreate);
' "$ROOT" "$OUT"

# 3) PUT each resource to its deterministic id (idempotent upsert). PQI Bundle is
#    a transaction/collection Bundle → POST it as a bundle to /  (HAPI processes
#    its entries). Everything else is Type/id and PUT-able directly.
put() {  # put <Type> <file>
  local type="$1" file="$2"
  local id; id="$(node -pe 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).id' "$file")"
  local code
  code="$(curl -s -o /tmp/apix-seed-resp.json -w '%{http_code}' \
    -X PUT "$BASE/$type/$id" \
    -H 'Content-Type: application/fhir+json' \
    --data-binary "@$file")"
  if [[ "$code" == 2* ]]; then
    echo "  ✓ PUT $type/$id  ($code)"
  else
    echo "  ✗ PUT $type/$id  ($code)"; cat /tmp/apix-seed-resp.json; echo; return 1
  fi
}

post_bundle() {  # post_bundle <file>
  local file="$1" code
  code="$(curl -s -o /tmp/apix-seed-resp.json -w '%{http_code}' \
    -X POST "$BASE" \
    -H 'Content-Type: application/fhir+json' \
    --data-binary "@$file")"
  if [[ "$code" == 2* ]]; then
    echo "  ✓ POST Bundle (PQI spec)  ($code)"
  else
    echo "  ✗ POST Bundle  ($code)"; cat /tmp/apix-seed-resp.json; echo; return 1
  fi
}

echo
echo "Seeding resources…"
put Organization      "$OUT/Organization-applicant.json"
put Organization      "$OUT/Organization-regulator.json"
put Endpoint          "$OUT/Endpoint.json"
put SubscriptionTopic "$OUT/SubscriptionTopic.json"
put SubscriptionTopic "$OUT/SubscriptionTopic-create.json"
put MedicinalProductDefinition "$OUT/MedicinalProductDefinition.json"

# The PQI bundle is collection-typed; if HAPI rejects a raw collection POST,
# it is non-fatal for the demo (the UI submits the spec as a Binary anyway).
echo
echo "Seeding PQI spec Bundle (best-effort; non-fatal)…"
post_bundle "$OUT/Bundle-pqi.json" || echo "  (PQI Bundle not stored as a transaction — fine; UI submits it as a Binary.)"

echo
echo "Done. Verify:  curl $BASE/SubscriptionTopic | head"
echo "Point the UI at: $BASE  (Backend → \"Local HAPI\")"
