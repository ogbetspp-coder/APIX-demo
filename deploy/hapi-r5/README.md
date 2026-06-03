# Self-hosted HAPI FHIR R5 — the real APIX server

This is the **real** backend for the APIX demo: a self-hosted
[HAPI FHIR](https://hapifhir.io) JPA server configured for **FHIR R5** with
**WebSocket** and **REST-hook** subscriptions enabled. The browser UI talks to
it as a genuine FHIR client (REST + real-time push).

> The public `hapi.fhir.org/baseR5` does **not** expose WebSocket subscriptions
> (no `websocket` in its CapabilityStatement). That is why real-time push
> targets **this** self-hosted server. The UI's "Live · HAPI R5" mode still uses
> the public server for REST and falls back to poll/read-back for updates.

## Quick start

```bash
cd deploy/hapi-r5

# 1) Start the server
docker compose up -d

# 2) Wait until it reports healthy (CapabilityStatement is up)
docker compose ps                       # STATUS should show (healthy)
# or watch it:
until curl -sf http://localhost:8080/fhir/metadata >/dev/null; do sleep 3; done
echo "HAPI R5 is up."

# 3) Seed the foundation resources (idempotent)
./seed.sh                               # → http://localhost:8080/fhir

# 4) Point the UI at it
#    Open ../../index.html, set Backend → "Local HAPI"
#    (default base http://localhost:8080/fhir; editable in the UI).
```

## The exact real-time verification (WebSocket push)

This is the loop that proves real R5 push delivery end-to-end:

1. In the UI, switch **Backend → "Local HAPI"**.
2. Run **Connect → Submit**. The UI POSTs the Binaries, DocumentReferences and
   the **Task** to your server (real `201`s, real server-assigned ids).
3. Run **Subscribe**. The UI:
   - POSTs a real `Subscription` with `channelType: websocket` filtered to the
     Task identifier, then
   - opens a WebSocket to `ws://localhost:8080/fhir/websocket` and sends
     `bind {Subscription.id}`; the server replies `bound {id}`.
   - The **I/O inspector** ("API calls" drawer) shows the bind as an `io` entry.
4. Advance the Task as the **regulator** (e.g. *Approve*). The UI PUTs the Task
   (`status: completed`, `businessStatus: approved`).
5. Because the Task now matches the Subscription's topic + filter, the server
   pushes a `ping {Subscription.id}` over the WebSocket. The UI catches it,
   GETs the fresh Task, and drives the **same** `notification` flow Act 3 uses —
   a real-time update with **no polling**. The inspector shows the inbound push.

If the WebSocket errors, closes, or never binds within `APIX.config.wsBindMs`
(default 4 s), the UI **automatically falls back** to poll/read-back, so the
demo always advances. (Set `wsBindMs` / `pollMs` in `js/config.js`.)

Sanity-check that the server advertises websocket:

```bash
curl -s http://localhost:8080/fhir/metadata \
  | grep -o '"websocket"' && echo "websocket advertised"
```

## What `seed.sh` loads

Idempotent PUTs to deterministic ids (re-running overwrites in place):

| Resource | id |
| --- | --- |
| Organization (applicant — SynthPharma AG) | `org-synthpharma-ag` |
| Organization (regulator — Health Authority) | `org-ema-srm-hmed` |
| Endpoint (notification webhook) | `endpoint-synthpharma` |
| SubscriptionTopic (status-change) | `TaskStatusChangeWithIdentifierFilter` |
| SubscriptionTopic (task-create) | `TaskCreationWithOrganizationAssignedFilter` |
| MedicinalProductDefinition (Velexa, product context) | `mpd-velexa175` |
| PQI spec Bundle (best-effort) | — |

The UI creates the run-time resources (Binaries, DocumentReferences, Task, the
WebSocket Subscription) itself when you drive Connect → Submit → Subscribe.

## Configuration

All server config is in [`application.yaml`](./application.yaml):

- `hapi.fhir.fhir_version: R5`
- `hapi.fhir.subscription.websocket_enabled: true`
- `hapi.fhir.subscription.resthook_enabled: true`
- `hapi.fhir.cors.allowed_origin: ['*']`
- PQI IG auto-loaded from the registry (`hl7.fhir.uv.pharm-quality`).

### Loading the APIX IG (optional)

`hl7.fhir.uv.apix` is a **continuous-build** IG and is **not** on the FHIR
package registry, so HAPI can't fetch it by name. To enforce APIX profiles:

1. Download the build package:
   ```bash
   curl -sSL -o apix-package.tgz \
     "https://build.fhir.org/ig/HL7/APIX---API-Exchange-for-Medicinal-Products/package.tgz"
   ```
2. In `docker-compose.yml`, uncomment the `./apix-package.tgz:/configs/apix-package.tgz:ro` mount.
3. In `application.yaml`, uncomment the `apix:` block under
   `hapi.fhir.implementationguides` (it points at `file:///configs/apix-package.tgz`).
4. `docker compose up -d` again.

This is **optional**: the server starts cleanly without it, and v1 of the demo
does not depend on APIX profile enforcement.

## AWS note (same compose, portable)

The same `docker-compose.yml` runs on **EC2** (Docker) or as an **ECS** task
unchanged. Two adjustments for a hosted deployment:

- **CORS**: in `application.yaml`, set `hapi.fhir.cors.allowed_origin` to your
  exact UI origin (e.g. `https://apix.example.org`) instead of `*`.
- **WebSocket scheme**: serve the UI and the server over HTTPS/TLS so the UI
  derives `wss://` for the WebSocket (it derives ws/wss from the base URL
  automatically — an `https://…/fhir` base → `wss://…/websocket`). Make sure
  your load balancer / proxy forwards WebSocket upgrade headers to `/fhir/websocket`.

Persisted data lives in the `hapi-data` volume (H2 file DB); remove it to reset.
