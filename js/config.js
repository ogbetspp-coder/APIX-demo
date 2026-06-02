/*
 * Runtime configuration for the data layer / client seam.
 *
 *   backend   'mock' (default) → in-memory APIX.MockFhirServer (synchronous).
 *             'hapi'           → real fetch() against a live FHIR R5 endpoint.
 *   hapiBase  base URL used when backend === 'hapi'.
 *   latencyMs artificial delay hook for the mock adapter (0 = synchronous; the
 *             scripted demo runs at 0 so everything stays deterministic).
 *
 * The demo ships on 'mock' so it runs fully offline from file://. Flip `backend`
 * to 'hapi' to drive the very same client against a real server.
 */
window.APIX = window.APIX || {};

APIX.config = {
  backend: 'mock',
  hapiBase: 'https://hapi.fhir.org/baseR5',
  latencyMs: 0
};
