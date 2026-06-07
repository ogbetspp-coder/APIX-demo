/*
 * APIX.store — the demo's data orchestration layer. It owns the storyline's
 * resource builders (dual-format spec, Task, regulator outputs) and the
 * applicant/regulator workflow, but the actual FHIR I/O now runs through
 * APIX.client (→ APIX.server, the in-memory MockFhirServer, or real HAPI).
 *
 * Public API and emitted events are UNCHANGED — js/app.js consumes:
 *   'task'         { task, firstTime }                      -> Task created/updated
 *   'notification' { bundle, businessStatus, taskStatus, seq } -> real-time push
 *   'reset'        {}                                       -> cleared
 *
 * Creates/updates go to APIX.client (which emits its own richer 'io' events on
 * APIX.client.bus). The status-change Subscription is delivered server-side; we
 * relay that delivery into the unchanged 'notification' event below.
 */
window.APIX = window.APIX || {};

/* UTF-8 safe base64 (for embedding FHIR/PDF payloads in Binary.data). */
APIX.b64 = function (str) {
  try { return btoa(unescape(encodeURIComponent(str))); }
  catch (e) { return btoa(str); }
};

/* Regulator-produced outputs, keyed by scenario effect codes. */
APIX.OUTPUTS = {
  ack:        { id: 'output-ack',        ctd: 'acknowledgement-receipt', title: 'Acknowledgement of Receipt' },
  validation: { id: 'output-validation', ctd: 'validation-report',       title: 'Filing Communication' },
  approval:   { id: 'docref-approval',   ctd: 'approval-letter',         title: 'Approval Letter' },
  assessment: { id: 'docref-assessment', ctd: 'assessment-report',       title: 'Review Memorandum' },
  rejection:  { id: 'docref-rejection',  ctd: 'assessment-report',       title: 'Complete Response Letter' }
};

/* The FDA Information Request exchange content (anchored in the CMC stability
 * change): FDA's quality/CMC question and the sponsor's response — surfaced as a
 * genuine quick back-and-forth on the FDA⇄sponsor channel. */
APIX.RSI = {
  question: 'Quality (CMC). Justify the proposed tightening of the end-of-shelf-life Water Content acceptance ' +
    'criterion (2.0% → 1.5% w/w) and confirm it is supported by the available long-term stability data. Confirm the ' +
    'analytical procedure (Karl Fischer, USP <921>) remains validated for the revised limit and clarify any impact on ' +
    'the approved shelf life.',
  answer: 'The revised 1.5% w/w end-of-shelf-life limit is supported by 36-month long-term stability data on three ' +
    'production-scale batches (maximum observed 1.2% w/w). The change tightens the criterion and does not affect the ' +
    'approved 36-month shelf life. Water Content is determined by Karl Fischer titration (USP <921>), validated per ' +
    'ICH Q2(R2); no method change is required.'
};

/* v3 terminology systems used by Provenance.activity + agent.type. */
APIX.PROV = {
  dataOperation: 'http://terminology.hl7.org/CodeSystem/v3-DataOperation',
  participantType: 'http://terminology.hl7.org/CodeSystem/provenance-participant-type'
};

APIX.store = {
  resources: {},          // local cache: "Type/id" -> resource (mirrors server)
  bus: new EventTarget(),
  subscriptions: [],
  eventCount: 0,
  token: null,
  task: null,
  taskUrl: null,          // public URL of the server-created Task (live mode)
  conformance: null,      // last $validate OperationOutcome (conformance check)
  submissionInputs: [],
  provenance: [],         // ordered in-memory audit log (21 CFR Part 11 / ALCOA)
  _provSeq: 0,
  _deliveryWired: false,

  // "Live" = any real-server backend (public HAPI or self-hosted local HAPI):
  // real fetch() round-trips, referential-integrity flattening, $validate, etc.
  _isLive: function () { return !!(APIX.config && (APIX.config.backend === 'hapi' || APIX.config.backend === 'local')); },

  // WebSocket real-time only targets a self-hosted HAPI ('local'): the public
  // server does not expose /websocket. State for the live WS subscription:
  _isLocal: function () { return !!(APIX.config && APIX.config.backend === 'local'); },
  _ws: null,              // the open WebSocket (when push is active)
  _wsBound: false,        // true once the server confirmed `bound {id}`
  _wsSubId: null,         // server-assigned Subscription.id we bound to
  _wsActive: function () { return !!(this._ws && this._wsBound); },

  /* Derive the WebSocket endpoint from the active REST base:
   *   http://host:8080/fhir  → ws://host:8080/fhir/websocket
   *   https://host/fhir      → wss://host/fhir/websocket
   * (HAPI serves the subscription WebSocket at {base}/websocket.) */
  _wsUrl: function () {
    var base = (APIX.config.activeBase ? APIX.config.activeBase() : APIX.config.localBase);
    var ws = base.replace(/^http/, 'ws').replace(/\/+$/, '');
    return ws + '/websocket';
  },

  /* Tear down any open WebSocket and reset its state. Safe to call repeatedly
   * (reset() and backend switches call it). */
  _closeWebSocket: function () {
    if (this._ws) {
      try { this._ws.onopen = this._ws.onmessage = this._ws.onerror = this._ws.onclose = null; } catch (e) {}
      try { this._ws.close(); } catch (e) {}
    }
    this._ws = null;
    this._wsBound = false;
    this._wsSubId = null;
  },

  /* Open the HAPI subscription WebSocket and perform the documented handshake:
   *   client → "bind {Subscription.id}"
   *   server → "bound {Subscription.id}"
   *   server → "ping  {Subscription.id}"   (on each matching event)
   * On a ping we GET the Task and drive the SAME 'notification' flow the UI
   * already consumes. Resolves true once `bound` is seen; resolves false if the
   * socket errors/closes or does not bind within APIX.config.wsBindMs — callers
   * then fall back to poll/read-back. Requires a global WebSocket (browser /
   * Node 22); when absent, resolves false immediately. */
  _openWebSocket: function (subId) {
    var self = this;
    this._closeWebSocket();
    var WS = (typeof WebSocket !== 'undefined') ? WebSocket : (typeof window !== 'undefined' ? window.WebSocket : null);
    if (!WS || !subId) return Promise.resolve(false);

    var url = this._wsUrl();
    return new Promise(function (resolve) {
      var settled = false;
      var ws;
      try { ws = new WS(url); } catch (e) { resolve(false); return; }
      self._ws = ws;
      self._wsSubId = subId;

      var bindTimer = setTimeout(function () {
        if (!settled) { settled = true; self._closeWebSocket(); resolve(false); }
      }, (APIX.config && APIX.config.wsBindMs) || 4000);

      ws.onopen = function () {
        // HAPI handshake: ask the server to bind this socket to our Subscription.
        try { ws.send('bind ' + subId); } catch (e) {}
        if (APIX.client && APIX.client.record) {
          APIX.client.record('WebSocket bind → ' + url,
            { method: 'WS', url: url, headers: {}, body: 'bind ' + subId },
            { status: 101, statusText: 'Switching Protocols', headers: {}, body: null });
        }
      };

      ws.onmessage = function (ev) {
        var msg = (typeof ev.data === 'string') ? ev.data.trim() : '';
        if (/^bound\b/i.test(msg)) {
          self._wsBound = true;
          if (!settled) { settled = true; clearTimeout(bindTimer); resolve(true); }
          return;
        }
        if (/^ping\b/i.test(msg)) {
          // A matching event fired server-side: pull the fresh Task and drive
          // the existing notification flow (real push — no polling).
          self._onWsPing(url, msg);
        }
      };

      ws.onerror = function () {
        if (!settled) { settled = true; clearTimeout(bindTimer); self._closeWebSocket(); resolve(false); }
      };
      ws.onclose = function () {
        self._wsBound = false;
        if (!settled) { settled = true; clearTimeout(bindTimer); resolve(false); }
      };
    });
  },

  /* Handle an inbound `ping {id}`: re-GET the Task off the server (real round-
   * trip), then emit the SAME 'notification' detail the UI already consumes. */
  _onWsPing: function (url, msg) {
    var self = this;
    if (APIX.client && APIX.client.record) {
      APIX.client.record('WebSocket ping ← ' + url,
        { method: 'WS', url: url, headers: {}, body: null },
        { status: 200, statusText: 'event', headers: {}, body: msg });
    }
    if (!this.task || !this.task.id) return;
    this.getAsync('Task/' + this.task.id).then(function (fresh) {
      if (fresh && fresh.resourceType === 'Task') { self.task = fresh; self.put(fresh); }
      var bizCode = (self.task.businessStatus && self.task.businessStatus.coding && self.task.businessStatus.coding[0])
        ? self.task.businessStatus.coding[0].code : 'submitted';
      // buildNotificationBundle() bumps eventCount itself; use its post-bump value as seq.
      var bundle = self.buildNotificationBundle(self.task.status, bizCode);
      self.bus.dispatchEvent(new CustomEvent('notification', {
        detail: { bundle: bundle, businessStatus: bizCode, taskStatus: self.task.status, seq: self.eventCount, viaWebSocket: true }
      }));
    });
  },

  /* Convert a Task's references to display-only so a live POST to a server that
   * enforces referential integrity (HAPI) succeeds without pre-creating every
   * referenced resource. Still valid R5: Reference.display alone is permitted. */
  _flattenRefs: function (task) {
    function flat(r) { if (r && r.reference) { r.display = r.display || r.reference.split('/').pop(); delete r.reference; } }
    flat(task.focus); flat(task.requester); flat(task.owner);
    (task.input || []).forEach(function (i) { flat(i.valueReference); });
    (task.output || []).forEach(function (o) { flat(o.valueReference); });
    return task;
  },

  /* ---- Audit trail — FHIR R5 Provenance per Task lifecycle transition ----
   * Build a valid base-R5 Provenance capturing the who/what/when/why of one
   * lifecycle step (21 CFR Part 11 / ALCOA: attributable, contemporaneous,
   * original, accurate). It is appended to the in-memory audit log, emitted on
   * the bus so the UI can render it, and — on a real backend — written to the
   * server with client.create() so it is a genuine server record. Keeping it a
   * separate write means the emitted Task/DocumentReference shapes are unchanged.
   *
   *   spec = {
   *     activity:  'CREATE' | 'UPDATE',
   *     actor:     'applicant' | 'regulator',   // who performed the act
   *     targets:   ['Task/<id>', 'DocumentReference/<id>', ...],
   *     reason:    short human "why" (the businessStatus / Task.code transition)
   *   }
   */
  _buildProvenance: function (spec) {
    var now = new Date().toISOString();
    var isReg = spec.actor === 'regulator';
    var org = isReg ? APIX.seed.regulator : APIX.seed.applicant;
    var display = isReg ? 'FDA' : 'SynthPharma AG';
    // Author = the org that performed the act; custodian = the data steward.
    // For a regulator action the regulator authors and also custodies the
    // record on its side; for an applicant submission SynthPharma authors.
    var agentCode = isReg ? 'custodian' : 'author';
    this._provSeq += 1;
    return {
      resourceType: 'Provenance',
      id: 'prov-' + this._provSeq,
      target: (spec.targets || []).map(function (ref) { return { reference: ref }; }),
      recorded: now,
      // R5: Provenance.activity is a single CodeableConcept. The v3-DataOperation
      // coding is the machine "what"; .text carries the human "why" (the
      // businessStatus / Task.code transition) for rendering.
      activity: {
        coding: [{ system: APIX.PROV.dataOperation, code: spec.activity,
          display: spec.activity === 'CREATE' ? 'create' : 'update' }],
        text: spec.reason
      },
      // R5: the rationale for the activity lives in Provenance.authorization
      // (CodeableReference). (R4's Provenance.reason was renamed/retyped in R5.)
      authorization: [{ concept: { text: spec.reason } }],
      agent: [{
        type: { coding: [{ system: APIX.PROV.participantType, code: agentCode,
          display: agentCode === 'custodian' ? 'Custodian' : 'Author' }] },
        who: { reference: 'Organization/' + org.id, display: display }
      }]
    };
  },

  /* Build, record (audit log), emit, and — when live — persist a Provenance. */
  recordProvenance: async function (spec) {
    var prov = this._buildProvenance(spec);
    this.provenance.push(prov);
    this.put(prov);
    // Real server write so the audit record genuinely exists server-side; guard
    // keeps the mock fully in-process (the mock server already stores creates).
    if (this._isLive()) {
      var p = JSON.parse(JSON.stringify(prov));
      // Targets may not be addressable on a foreign server by these local ids;
      // keep them display-only so the create is a self-contained round-trip.
      (p.target || []).forEach(function (t) {
        if (t.reference) { t.display = t.reference.split('/').pop(); delete t.reference; }
      });
      try { await APIX.client.create(p, { label: 'Audit — Provenance (' + spec.activity + ')' }); }
      catch (e) { /* audit write is best-effort; never block the workflow */ }
    }
    this.bus.dispatchEvent(new CustomEvent('provenance', { detail: { provenance: prov } }));
    return prov;
  },

  reset: function () {
    this._closeWebSocket();
    this.resources = {};
    this.subscriptions = [];
    this.eventCount = 0;
    this.token = null;
    this.task = null;
    this.taskUrl = null;
    this.conformance = null;
    this.submissionInputs = [];
    this.provenance = [];
    this._provSeq = 0;
    // Fresh server state so a re-run starts clean.
    if (APIX.MockFhirServer) {
      APIX.server = new APIX.MockFhirServer();
      this._deliveryWired = false;
      this._wireClient();
    }
    this.bus.dispatchEvent(new CustomEvent('reset'));
  },

  /* Relay the mock server's subscription deliveries into the unchanged
   * 'notification' event (and re-attach the client's 'io' recorder). */
  _wireClient: function () {
    var self = this;
    if (!APIX.server) return;
    // Re-attach client's io recorder for inbound deliveries (reset rebuilds server).
    APIX.server.onDeliver = function (detail) {
      if (APIX.client && APIX.client.record) {
        APIX.client.record(
          'Notification → subscriber',
          { method: 'POST', url: detail.endpoint || 'Subscription/notify', headers: { 'Content-Type': 'application/fhir+json' }, body: detail.bundle },
          { status: 200, statusText: 'OK', headers: { 'Content-Type': 'application/fhir+json' }, body: null }
        );
      }
    };
    if (!self._deliveryWired) {
      APIX.server.onDelivery(function (detail) {
        self.eventCount += 1;
        self.bus.dispatchEvent(new CustomEvent('notification', {
          detail: { bundle: detail.bundle, businessStatus: detail.businessStatus, taskStatus: detail.taskStatus, seq: self.eventCount }
        }));
      });
      self._deliveryWired = true;
    }
  },

  /* Cache a resource locally so get() resolves it even before/without a read. */
  put: function (resource, dir, label, silent) {
    var key = resource.resourceType + '/' + resource.id;
    this.resources[key] = resource;
    return resource;
  },

  /* Read a resource synchronously: prefer the in-memory mock server, fall back
   * to the local cache. (Used by the UI for cached/mock lookups; the live read-
   * back path is getAsync().) */
  get: function (ref) {
    if (!this._isLive() && APIX.server && typeof ref === 'string' && ref.indexOf('/') > 0) {
      var resp = APIX.server.request('GET', '/' + ref);
      if (resp && resp.status === 200 && resp.body) { this.resources[ref] = resp.body; return resp.body; }
    }
    return this.resources[ref] || null;
  },

  /* Read a resource, awaiting a real round-trip when live. Resolves to the
   * server's copy (and refreshes the cache); falls back to the cache. */
  getAsync: function (ref) {
    var self = this;
    if (this._isLive()) {
      return APIX.client.read(ref).then(function (body) {
        if (body && body.resourceType) { self.resources[ref] = body; return body; }
        return self.resources[ref] || null;
      });
    }
    return Promise.resolve(this.get(ref));
  },

  /* ---- APIX Step 1: Connect -------------------------------------------- */
  connect: async function () {
    this._wireClient();
    // Simulated SMART Backend Services OAuth2 token exchange — surfaced on the
    // 'io' feed for the inspector (no real network; clearly a mock).
    this.token = 'eyJraWQiOiJzeW50aHBoYXJtYS0wMSIsInR5cCI6IkpXVC…';
    if (APIX.client && APIX.client.record) {
      APIX.client.record('OAuth2 token (SMART Backend Services)',
        { method: 'POST', url: '/oauth2/token', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: { grant_type: 'client_credentials', client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
                  scope: 'system/Task.cruds system/DocumentReference.cruds system/Binary.cruds system/Subscription.cruds' } },
        { status: 200, statusText: 'OK', headers: { 'Content-Type': 'application/json' },
          body: { access_token: this.token, token_type: 'Bearer', expires_in: 300,
                  scope: 'system/Task.cruds system/DocumentReference.cruds system/Binary.cruds system/Subscription.cruds' } });
    }
    // Register applicant Organization + notification Endpoint.
    this.put(await APIX.client.create(APIX.seed.applicant, { label: 'Register Organization (SynthPharma AG)' }));
    this.put(await APIX.client.create(APIX.seed.endpoint, { label: 'Register Endpoint (notification webhook)' }));
  },

  /* ---- Build the ONE payload: a single DocumentReference for the structured
   * drug-product specification, whose Binary.data is the PQI FHIR Bundle. The
   * Document⇄FHIR toggle in the UI renders this same artifact two ways (eCTD
   * 3.2.P.5.1 document view vs. the Bundle) — it is one payload, not two. ---- */
  buildSubmissionDocs: function () {
    var bundleJson = JSON.stringify(APIX.pqi.bundle || APIX.pqi.normalize());
    return [{
      kind: 'fhir',
      binary: { resourceType: 'Binary', id: 'binary-spec-fhir', contentType: 'application/fhir+json', data: APIX.b64(bundleJson) },
      docref: this._docref('docref-spec-fhir', '3.2.P.5.1', 'application/fhir+json', 'Drug Product Specification (structured PQI Bundle)', 'Binary/binary-spec-fhir')
    }];
  },

  _docref: function (id, ctd, contentType, title, url, size) {
    var now = new Date().toISOString();
    return {
      resourceType: 'DocumentReference',
      id: id,
      meta: { profile: [APIX.SYS.profile.docref] },
      // apix-documentreference requires exactly two identifiers: a document-set id and a version id.
      identifier: [
        // NB: display values below are the slice patterns from apix-documentreference (the
        // `value` discriminator on type requires them verbatim to match the slice). The
        // docverid pattern display ("Document Version Identifier") differs from the
        // apix-demo CodeSystem display ("Document Version Number Identifier") — an upstream
        // IG inconsistency; matching the slice pattern is preferred so the structure is valid.
        { use: 'official', type: { coding: [{ system: APIX.SYS.idType, code: 'docsetid', display: 'Document Set Identifier' }] }, system: APIX.SYS.docRefIdSystem, value: 'urn:uuid:' + APIX.uuid() },
        { use: 'official', type: { coding: [{ system: APIX.SYS.idType, code: 'docverid', display: 'Document Version Identifier' }] }, system: APIX.SYS.docVerSystem, value: 'urn:uuid:' + APIX.uuid() }
      ],
      version: '2.0',
      status: 'current',
      docStatus: 'final',
      type: { coding: [{ system: APIX.SYS.ctd, code: ctd, display: APIX.display('ctd', ctd) }] },
      category: [{ coding: [{ system: APIX.SYS.ctd, code: 'm3', display: 'Module 3' }] }],
      subject: { reference: 'MedicinalProductDefinition/' + APIX.seed.product.id },
      author: [{ reference: 'Organization/' + APIX.seed.applicant.id }],
      date: now,
      // size is FHIR integer64 → must be serialised as a JSON string.
      content: [{ attachment: { contentType: contentType, url: url, title: title, size: String(size || 256000), creation: now } }]
    };
  },

  /* ---- APIX Steps 2-4: Stream + Describe + Orchestrate ----------------- */
  submit: async function () {
    var docs = this.buildSubmissionDocs();
    this.submissionInputs = [];

    // Step 2 — Stream each file as Binary (sequential: each create awaited)
    for (var b = 0; b < docs.length; b++) {
      var dB = docs[b];
      this.put(await APIX.client.create(dB.binary, { label: 'Stream document (Binary · ' + dB.binary.contentType + ')' }));
    }
    // Step 3 — Describe each with a DocumentReference
    for (var k = 0; k < docs.length; k++) {
      var dD = docs[k];
      this.put(await APIX.client.create(dD.docref, { label: 'Describe — ' + dD.docref.content[0].attachment.title }));
      this.submissionInputs.push({
        type: { coding: [{ system: APIX.SYS.ctd, code: dD.docref.type.coding[0].code, display: dD.docref.type.coding[0].display }] },
        valueReference: { reference: 'DocumentReference/' + dD.docref.id, display: dD.docref.content[0].attachment.title }
      });
    }
    // Step 4 — Orchestrate with a Task (POST creates the variation Task)
    var task = this.buildTask();
    // Live: the public HAPI server enforces referential integrity, but our
    // supporting resources (MPD product-context, regulator Org, the just-created
    // DocumentReferences under their original ids) are not addressable there by
    // these local ids. Convert the Task's references to display-only — still
    // valid R5 (a Reference may carry only .display) — so the create succeeds as
    // a single, self-contained, real round-trip. Mock keeps full references.
    if (this._isLive()) this._flattenRefs(task);
    var stored = await APIX.client.create(task, { label: 'Orchestrate — Task (Prior Approval Supplement, created)' });
    this.task = stored;                 // server-returned Task (with server meta)
    this.put(stored);

    // Capture the server-assigned Task id and build its public URL when live, so
    // a skeptic can open the very Task we just created on a server we don't own.
    if (this._isLive() && stored && stored.id) {
      this.taskUrl = (APIX.config.activeBase ? APIX.config.activeBase() : APIX.config.hapiBase) + '/Task/' + stored.id;
    }

    // Conformance check (AUTOMATIC, in-flight) — FHIR `$validate` → OperationOutcome
    // (format/profile conformance, NOT a human act; see docs/REGULATORY-FLOW.md).
    // Live: a REAL HAPI $validate. Mock: the in-process server returns an
    // informational OperationOutcome. Either way the result is surfaced in
    // Inspect and stored so the UI can show a sober "Conformance ✓" tag.
    try {
      this.conformance = await APIX.client.validate(this.task);
    } catch (e) { this.conformance = null; }

    // Notify the regulator (owner) -> populate its console. (The status-change
    // Subscription is registered later, in subscribe(); it drives Act 3.)
    this.bus.dispatchEvent(new CustomEvent('task', { detail: { task: this.task, firstTime: true } }));

    // Audit: the submission created the Task and its input DocumentReferences.
    var provTargets = ['Task/' + this.task.id];
    this.submissionInputs.forEach(function (inp) {
      if (inp.valueReference && inp.valueReference.reference) provTargets.push(inp.valueReference.reference);
    });
    await this.recordProvenance({
      activity: 'CREATE', actor: 'applicant', targets: provTargets,
      reason: 'Submitted Prior Approval Supplement — Task created (businessStatus: Submitted)'
    });
    return this.task;
  },

  buildTask: function () {
    var now = new Date().toISOString();
    return {
      resourceType: 'Task',
      id: APIX.TASK_ID,
      meta: { versionId: '1', lastUpdated: now, profile: [APIX.SYS.profile.task] },
      text: {
        status: 'generated',
        div: '<div xmlns="http://www.w3.org/1999/xhtml">Prior Approval Supplement: tightening of the end-of-shelf-life Water Content limit for ' +
          APIX.seed.product.name[0].productName + '.</div>'
      },
      identifier: [{ use: 'official', type: { coding: [{ system: APIX.SYS.idType, code: 'apixtaskinstance', display: 'APIX Task Instance ID' }] }, system: APIX.SYS.taskIdSystem, value: APIX.TASK_UUID }],
      groupIdentifier: { use: 'official', system: APIX.SYS.groupIdSystem, value: APIX.TASK_GROUP_UUID },
      status: 'requested',
      businessStatus: { coding: [{ system: APIX.SYS.businessStatus, code: 'submitted', display: 'Submitted' }] },
      intent: 'proposal',
      priority: 'routine',
      code: { coding: [{ system: APIX.SYS.taskCode, code: 'supplement', display: 'Prior Approval Supplement' }] },
      focus: { reference: 'MedicinalProductDefinition/' + APIX.seed.product.id, display: APIX.seed.product.name[0].productName },
      authoredOn: now,
      lastModified: now,
      requester: { reference: 'Organization/' + APIX.seed.applicant.id, display: 'SynthPharma AG' },
      owner: { reference: 'Organization/' + APIX.seed.regulator.id, display: 'FDA' },
      input: this.submissionInputs
    };
  },

  /* ---- APIX Step 5: Subscribe ------------------------------------------ */
  subscribe: async function () {
    // Register the topic on the mock server (so the engine can evaluate it). On
    // the live server these topics already exist; we only POST the Subscription.
    if (!this._isLive() && APIX.server) {
      APIX.server.registerTopic(APIX.seed.topicStatus);
      APIX.server.registerTopic(APIX.seed.topicCreate);
    }
    var sub = APIX.seed.subscription;
    // Self-hosted HAPI ('local') exposes a real WebSocket channel: POST a
    // Subscription with channelType=websocket so the server will push us a
    // `ping` on each matching Task change. Public HAPI / mock keep the seed's
    // rest-hook channel (no usable push there → poll/read-back).
    if (this._isLocal()) sub = this._websocketSubscription(APIX.seed.subscription);

    // POST a REAL Subscription so it exists/visible on the server (live mode).
    var stored = await APIX.client.createSubscription(sub);
    if (stored && stored.resourceType === 'Subscription') sub = stored;
    if (!this._isLive() && APIX.server) APIX.server.registerSubscription(APIX.seed.subscription);
    this.subscriptions.push(sub);
    this.put(sub);

    // Local HAPI: open the WebSocket and bind to the just-created Subscription.
    // On success, updates arrive as real push; on failure we silently fall back
    // to poll/read-back in updateTask() (this._wsActive() stays false).
    if (this._isLocal() && stored && stored.id) {
      await this._openWebSocket(stored.id);
    }
  },

  /* Build a websocket-channel variant of the seed Subscription (deep-cloned so
   * the seed object is untouched). HAPI delivers a `ping {id}` over the socket
   * for matching events; .endpoint is dropped (the channel is the open socket). */
  _websocketSubscription: function (seed) {
    var sub = JSON.parse(JSON.stringify(seed));
    sub.channelType = { system: APIX.SYS.channelType, code: 'websocket' };
    delete sub.endpoint;
    return sub;
  },

  /* ---- Regulator advances the Task; fires notifications ---------------- */
  updateTask: async function (effect) {
    var self = this;
    this.task.status = effect.status;
    this.task.businessStatus = { coding: [{ system: APIX.SYS.businessStatus, code: effect.businessStatus, display: APIX.display('businessStatus', effect.businessStatus) }] };
    var nowIso = new Date().toISOString();
    this.task.lastModified = nowIso;

    // Decision-branch task codes (real apix-task-code members). The regulator's
    // decision/info-request and the applicant's response re-stamp Task.code so
    // the action is self-describing; still a valid apix-task-code coding.
    if (effect.taskCode) {
      this.task.code = { coding: [{ system: APIX.SYS.taskCode, code: effect.taskCode, display: APIX.display('taskCode', effect.taskCode) }] };
    }

    // A Reject decision records why on Task.statusReason (CodeableConcept). The
    // text is the human grounds; the businessStatus already says 'rejected'.
    if (effect.statusReason) {
      this.task.statusReason = { text: effect.statusReason };
    }

    if (effect.addProcedureNo) {
      this.task.identifier.push({ use: 'official', type: { coding: [{ system: APIX.SYS.idType, code: 'apixregulatorprocedureno', display: 'APIX Regulator Procedure Number' }] }, system: APIX.SYS.procedureSystem, value: '215123/S-005' });
    }
    if (effect.addOutputs) {
      this.task.output = this.task.output || [];
      for (var oi = 0; oi < effect.addOutputs.length; oi++) {
        var o = APIX.OUTPUTS[effect.addOutputs[oi]];
        var dref = self._docref(o.id, o.ctd, 'application/pdf', o.title, 'Binary/binary-' + o.id);
        dref.author = [{ reference: 'Organization/' + APIX.seed.regulator.id }];
        self.put(await APIX.client.create(dref, { label: 'Regulator output — ' + o.title }));
        self.task.output.push({ type: { coding: [{ system: APIX.SYS.ctd, code: o.ctd, display: APIX.display('ctd', o.ctd) }] }, valueReference: { reference: 'DocumentReference/' + o.id, display: o.title } });
      }
    }

    // PUT the updated Task. The server bumps meta.versionId + lastUpdated and,
    // (mock) because status changed, fires the status-change topic → delivers a
    // subscription-notification → our delivery listener emits 'notification'.
    // Live: keep newly-added output refs display-only too (referential integrity).
    if (this._isLive()) this._flattenRefs(this.task);
    var stored = await APIX.client.update(this.task, { label: 'Task → ' + effect.status + ' / ' + APIX.display('businessStatus', effect.businessStatus) });
    if (stored && stored.resourceType === 'Task') this.task = stored;   // adopt server meta (versionId bumped by server)
    this.put(this.task);
    this.bus.dispatchEvent(new CustomEvent('task', { detail: { task: this.task, firstTime: false } }));

    // Audit: this transition is a status change on the Task (UPDATE). The
    // applicant's response-to-questions is the one applicant-authored step; all
    // other transitions are regulator acts. Targets include any new outputs.
    var provActor = (effect.taskCode === 'response-to-questions') ? 'applicant' : 'regulator';
    var why = 'businessStatus → ' + APIX.display('businessStatus', effect.businessStatus) +
      ' (Task.status: ' + effect.status + ')' +
      (effect.taskCode ? '; Task.code: ' + APIX.display('taskCode', effect.taskCode) : '');
    var upTargets = ['Task/' + this.task.id];
    (effect.addOutputs || []).forEach(function (k) {
      if (APIX.OUTPUTS[k]) upTargets.push('DocumentReference/' + APIX.OUTPUTS[k].id);
    });
    await this.recordProvenance({ activity: 'UPDATE', actor: provActor, targets: upTargets, reason: why });

    // Live real-time. Two paths:
    //  (a) Local HAPI with an ACTIVE WebSocket bind → the server pushes a
    //      `ping` (handled in _onWsPing, which re-GETs the Task and emits
    //      'notification'). We just wait briefly for that push to land; if it
    //      doesn't (e.g. topic timing), we fall through to the read-back below.
    //  (b) Public HAPI, or local with no usable WebSocket → re-GET the Task
    //      (a real round-trip) and drive the SAME 'notification' flow from the
    //      data that genuinely came back off the server (poll/read-back).
    if (this._isLive()) {
      if (this._wsActive()) {
        var pushed = await this._awaitPush();
        if (pushed) return;   // the WebSocket ping already drove 'notification'
      }
      var fresh = await this.getAsync('Task/' + this.task.id);
      if (fresh && fresh.resourceType === 'Task') { this.task = fresh; this.put(fresh); }
      var bizCode = (this.task.businessStatus && this.task.businessStatus.coding && this.task.businessStatus.coding[0])
        ? this.task.businessStatus.coding[0].code : effect.businessStatus;
      var bundle = this.buildNotificationBundle(this.task.status, bizCode);
      this.bus.dispatchEvent(new CustomEvent('notification', {
        detail: { bundle: bundle, businessStatus: bizCode, taskStatus: this.task.status, seq: this.eventCount }
      }));
    }
  },

  /* Wait up to APIX.config.pollMs for a WebSocket 'notification' to fire after a
   * Task PUT. Resolves true if one arrived (so updateTask skips its read-back),
   * false on timeout (→ poll/read-back fallback). */
  _awaitPush: function () {
    var self = this;
    var before = this.eventCount;
    var waitMs = (APIX.config && APIX.config.pollMs) || 1500;
    return new Promise(function (resolve) {
      var done = false;
      function onNotif() { if (!done) { done = true; cleanup(); resolve(true); } }
      function cleanup() { self.bus.removeEventListener('notification', onNotif); clearTimeout(timer); }
      var timer = setTimeout(function () {
        if (!done) { done = true; cleanup(); resolve(self.eventCount > before); }
      }, waitMs);
      self.bus.addEventListener('notification', onNotif);
    });
  },

  /* Build the R5 subscription-notification Bundle (kept for any callers that
   * want it directly; the live notification path builds it server-side). */
  buildNotificationBundle: function (taskStatus, businessStatusCode) {
    this.eventCount += 1;
    var n = String(this.eventCount);
    return {
      resourceType: 'Bundle',
      id: 'notif-' + n,
      type: 'subscription-notification',
      timestamp: new Date().toISOString(),
      entry: [
        {
          fullUrl: 'urn:uuid:status-' + n,
          resource: {
            resourceType: 'SubscriptionStatus',
            status: 'active',
            type: 'event-notification',
            eventsSinceSubscriptionStart: n,
            notificationEvent: [{ eventNumber: n, timestamp: new Date().toISOString(), focus: { reference: 'Task/' + this.task.id } }],
            subscription: { reference: 'Subscription/' + APIX.seed.subscription.id },
            topic: APIX.SYS.topicStatus
          }
        },
        {
          fullUrl: 'https://api.health-authority.example/fhir/Task/' + this.task.id,
          resource: this.task,
          request: { method: 'PUT', url: 'Task/' + this.task.id }
        }
      ]
    };
  }
};
