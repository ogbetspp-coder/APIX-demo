#!/usr/bin/env bash
#
# Conformance evidence: validate the demo's FHIR resources against FHIR R5 and
# the REAL HL7 IGs — APIX (hl7.fhir.uv.apix, from its continuous-build package)
# and PQI (hl7.fhir.uv.pharm-quality, auto-loaded from the registry via
# meta.profile) — using the official HL7 FHIR Validator.
#
# Usage:  ./validation/validate.sh
# Needs:  Java 11+, network access (first run downloads the validator + packages).
#
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
JAR="${VALIDATOR_JAR:-/tmp/validator_cli.jar}"
APIX_IG="https://build.fhir.org/ig/HL7/APIX---API-Exchange-for-Medicinal-Products/package.tgz"

if [ ! -f "$JAR" ]; then
  echo "Downloading the official HL7 FHIR Validator (~186 MB)…"
  curl -sSL -o "$JAR" https://github.com/hapifhir/org.hl7.fhir.core/releases/latest/download/validator_cli.jar
fi

echo "Exporting resources from the JS data layer…"
node "$ROOT/validation/dump.js"

echo "Validating against FHIR R5 + APIX + PQI…"
java -jar "$JAR" /tmp/apix-res -version 5.0.0 -tx n/a -ig "$APIX_IG"
