# Conformance & evidence

For a skeptical audience, the proof isn't the UI — it's that **every resource the
demo emits is conformant FHIR R5 that passes the official HL7 validator against
the real APIX and PQI profiles.**

## Run it
```bash
./validation/validate.sh        # downloads the official validator on first run
```
Requires Java 11+ and network access. It exports the demo's resources and runs the
**official HL7 FHIR Validator** against **FHIR R5** plus:
- **APIX** — `hl7.fhir.uv.apix` (loaded from its continuous-build `package.tgz`)
- **PQI** — `hl7.fhir.uv.pharm-quality` v1.0.0 (auto-loaded from the registry via `meta.profile`)

Target: **0 errors** (warnings triaged and justified).

## Status — validator-derived punch-list (closing in v2)
A baseline run loads both IGs (APIX = 4,248 resources; PQI v1.0.0) and pinpoints the
exact gaps we are fixing. Recorded here so progress is auditable.

**PQI Bundle** (`Bundle-drug-product-specification-pq`)
- Use real lowercase UUIDs for `fullUrl`; http canonicals for `url` / `definitionCanonical`.
- Add the required entry slices the profile mandates: `MedicinalProductDefinition`
  (Product-Identification), `Ingredient` (Drug-Ingredient), `SubstanceDefinition`
  (Component-Substance), `Organization`.

**APIX `Task`** (`apix-task`)
- Add required `meta.versionId`, `text`, `groupIdentifier`; remove disallowed `description`.
- `identifier` value must be a real `urn:uuid` (constraint `identifier-is-uuid`).

**APIX `Organization`** (`apix-organization`)
- `contact.name` must be an array (R5 `ExtendedContactDetail`); add required `endpoint`; fix code displays.

**APIX `DocumentReference`** (`apix-documentreference`)
- Add required `attachment.creation`; `attachment.size` is `integer64` → JSON string;
  use valid `ctd-section` codes + exact displays.

**`Endpoint`** (R5)
- Replace the R4 `payloadType` with R5 `payload.type` / `payload.mimeType`.

**ConceptMap / `$translate`** (R5, build.fhir.org/conceptmap.html)
- `group.element.target.relationship` (R5; not R4 `equivalence`); `$translate`
  returns a `Parameters` with `result` + `match.relationship` + `match.concept`.

All of the above are driven to zero as part of the v2 build.
