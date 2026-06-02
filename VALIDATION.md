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

## Result (latest run)
**88 → 1 error.** 7 of 8 resource types validate with **0 errors** (SubscriptionTopic,
MedicinalProductDefinition, Subscription, Organization, Endpoint, Task, and the PQI
Bundle). The single residual is a **contradiction inside the APIX 0.1.0 draft IG
itself** — not a defect in the demo:

> `DocumentReference.identifier[docVersionNumberIdentifier].type.coding.display` —
> the `apix-documentreference` profile slices `identifier` with a *value*
> discriminator on `type`, and that slice's pattern hard-codes the display
> "Document Version Identifier", which contradicts the only display the `apix-demo`
> CodeSystem defines for the code ("Document Version Number Identifier"). No
> instance can satisfy both the structural slice and the terminology check
> simultaneously (confirmed identically against `tx.fhir.org`). We keep profile
> conformance (the structural slice is valid) and flag the display — a fix to raise
> upstream with the APIX work group.

Remaining non-error notes are benign and terminology-server-dependent (EDQM Standard
Terms, `dom-6` narrative best-practice, draft-CodeSystem info).

## What we fixed (validator-derived)
A baseline run loaded both IGs (APIX = 4,248 resources; PQI v1.0.0) and pinpointed
the exact gaps — now closed:

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

All of the above are now resolved (see **Result** above).
