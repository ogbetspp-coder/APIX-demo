/*
 * Runtime configuration for the data layer / client seam.
 *
 *   backend   'mock'  (default) → in-memory APIX.MockFhirServer (synchronous).
 *             'hapi'            → real fetch() against the PUBLIC HAPI R5 server
 *                                 (hapiBase). REST is real; no WebSocket there
 *                                 (the public server does not expose one), so
 *                                 real-time falls back to poll/read-back.
 *             'local'           → real fetch() against a SELF-HOSTED HAPI R5
 *                                 (localBase, e.g. the deploy/hapi-r5 Docker
 *                                 stack). REST is real AND, when the server
 *                                 advertises it, real-time is a genuine R5/HAPI
 *                                 WebSocket subscription (push) — see js/store.js.
 *
 *   hapiBase  base URL used when backend === 'hapi' (public, shared/auto-wiped).
 *   localBase base URL used when backend === 'local' (your Docker HAPI).
 *   latencyMs artificial delay hook for the mock adapter (0 = synchronous; the
 *             scripted demo runs at 0 so everything stays deterministic).
 *   pollMs    delay before the live read-back of the Task after a regulator PUT
 *             (used for the public-HAPI poll fallback AND as the WebSocket
 *             fallback when no push arrives in time).
 *   wsBindMs  how long subscribe() waits for the WebSocket `bound` handshake
 *             before giving up and falling back to poll/read-back.
 *
 * The demo ships on 'mock' so it runs fully offline from file://. Flip `backend`
 * to 'hapi' or 'local' to drive the very same client against a real server.
 */
window.APIX = window.APIX || {};

APIX.config = {
  backend: 'mock',
  hapiBase: 'https://hapi.fhir.org/baseR5',
  localBase: 'http://localhost:8080/fhir',
  latencyMs: 0,
  pollMs: 1500,
  wsBindMs: 4000
};

/* Resolve the active real-server base URL for the current backend.
 * ('mock' has no base; callers only ask this when live.) */
APIX.config.activeBase = function () {
  return APIX.config.backend === 'local' ? APIX.config.localBase : APIX.config.hapiBase;
};
