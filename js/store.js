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
 *   'wire'         { entry... }                             -> legacy wire feed (kept)
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
  validation: { id: 'output-validation', ctd: 'validation-report',       title: 'Validation Report' },
  approval:   { id: 'docref-approval',   ctd: 'approval-letter',         title: 'Approval Letter' },
  assessment: { id: 'docref-assessment', ctd: 'assessment-report',       title: 'Assessment Report' }
};

APIX.store = {
  resources: {},          // local cache: "Type/id" -> resource (mirrors server)
  bus: new EventTarget(),
  subscriptions: [],
  eventCount: 0,
  seq: 0,
  token: null,
  task: null,
  submissionInputs: [],
  _deliveryWired: false,

  reset: function () {
    this.resources = {};
    this.subscriptions = [];
    this.eventCount = 0;
    this.seq = 0;
    this.token = null;
    this.task = null;
    this.submissionInputs = [];
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

  /* Legacy wire feed (kept for compatibility; app.js does not consume it). */
  wire: function (dir, method, url, label, resource) {
    this.seq += 1;
    this.bus.dispatchEvent(new CustomEvent('wire', {
      detail: { seq: this.seq, dir: dir, method: method, url: url, label: label, resource: resource, ts: new Date() }
    }));
  },

  /* Cache a resource locally so get() resolves it even before/without a read. */
  put: function (resource, dir, label, silent) {
    var key = resource.resourceType + '/' + resource.id;
    this.resources[key] = resource;
    return resource;
  },

  /* Read a resource: prefer the live server, fall back to the local cache. */
  get: function (ref) {
    if (APIX.server && typeof ref === 'string' && ref.indexOf('/') > 0) {
      var resp = APIX.server.request('GET', '/' + ref);
      if (resp && resp.status === 200 && resp.body) { this.resources[ref] = resp.body; return resp.body; }
    }
    return this.resources[ref] || null;
  },

  /* ---- APIX Step 1: Connect -------------------------------------------- */
  connect: function () {
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
    this.put(APIX.client.create(APIX.seed.applicant, { label: 'Register Organization (SynthPharma AG)' }));
    this.put(APIX.client.create(APIX.seed.endpoint, { label: 'Register Endpoint (notification webhook)' }));
  },

  /* ---- Build the dual-format spec + supporting documents --------------- */
  buildSubmissionDocs: function () {
    var docs = [];
    var bundleJson = JSON.stringify(APIX.pqi.bundle || APIX.pqi.normalize());

    // (a) Spec as structured PQI FHIR Bundle
    docs.push({
      kind: 'fhir',
      binary: { resourceType: 'Binary', id: 'binary-spec-fhir', contentType: 'application/fhir+json', data: APIX.b64(bundleJson) },
      docref: this._docref('docref-spec-fhir', '3.2.P.5.1', 'application/fhir+json', 'Drug Product Specification (structured PQI Bundle)', 'Binary/binary-spec-fhir')
    });
    // (b) Same spec as a rendered eCTD PDF
    docs.push({
      kind: 'pdf',
      binary: { resourceType: 'Binary', id: 'binary-spec-pdf', contentType: 'application/pdf', data: APIX.b64('%PDF-1.7 Velexa 3.2.P.5.1 specification (rendered, demo stub)') },
      docref: this._docref('docref-spec-pdf', '3.2.P.5.1', 'application/pdf', 'Drug Product Specification (eCTD 3.2.P.5.1, PDF)', 'Binary/binary-spec-pdf')
    });
    // (c) The rest of the variation package (mocked)
    APIX.seed.supportingDocs.forEach(function (d) {
      docs.push({
        kind: 'support',
        binary: { resourceType: 'Binary', id: 'binary-' + d.id, contentType: 'application/pdf', data: APIX.b64('%PDF-1.7 ' + d.title + ' (demo stub)') },
        docref: APIX.store._docref(d.id, d.ctd, 'application/pdf', d.title, 'Binary/binary-' + d.id, d.size)
      });
    });
    return docs;
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
  submit: function () {
    var self = this;
    var docs = this.buildSubmissionDocs();
    this.submissionInputs = [];

    // Step 2 — Stream each file as Binary
    docs.forEach(function (d) {
      self.put(APIX.client.create(d.binary, { label: 'Stream document (Binary · ' + d.binary.contentType + ')' }));
    });
    // Step 3 — Describe each with a DocumentReference
    docs.forEach(function (d) {
      self.put(APIX.client.create(d.docref, { label: 'Describe — ' + d.docref.content[0].attachment.title }));
      self.submissionInputs.push({
        type: { coding: [{ system: APIX.SYS.ctd, code: d.docref.type.coding[0].code, display: d.docref.type.coding[0].display }] },
        valueReference: { reference: 'DocumentReference/' + d.docref.id, display: d.docref.content[0].attachment.title }
      });
    });
    // Step 4 — Orchestrate with a Task (POST triggers the create-topic)
    var task = this.buildTask();
    var stored = APIX.client.create(task, { label: 'Orchestrate — Task (Type IB variation, created)' });
    this.task = stored;                 // server-returned Task (with server meta)
    this.put(stored);
    // create-topic: regulator (owner) is notified -> populate its console
    this.bus.dispatchEvent(new CustomEvent('task', { detail: { task: this.task, firstTime: true } }));
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
        div: '<div xmlns="http://www.w3.org/1999/xhtml">Type IB variation (B.II.d.1): tightening of the end-of-shelf-life Water Content limit for ' +
          APIX.seed.product.name[0].productName + '.</div>'
      },
      identifier: [{ use: 'official', type: { coding: [{ system: APIX.SYS.idType, code: 'apixtaskinstance', display: 'APIX Task Instance ID' }] }, system: APIX.SYS.taskIdSystem, value: APIX.TASK_UUID }],
      groupIdentifier: { use: 'official', system: APIX.SYS.groupIdSystem, value: APIX.TASK_GROUP_UUID },
      status: 'requested',
      businessStatus: { coding: [{ system: APIX.SYS.businessStatus, code: 'submitted', display: 'Submitted' }] },
      intent: 'proposal',
      priority: 'routine',
      code: { coding: [{ system: APIX.SYS.taskCode, code: 'variation-type-ib', display: 'Type IB Variation' }] },
      focus: { reference: 'MedicinalProductDefinition/' + APIX.seed.product.id, display: APIX.seed.product.name[0].productName },
      authoredOn: now,
      lastModified: now,
      requester: { reference: 'Organization/' + APIX.seed.applicant.id, display: 'SynthPharma AG' },
      owner: { reference: 'Organization/' + APIX.seed.regulator.id, display: 'Health Authority' },
      input: this.submissionInputs
    };
  },

  /* ---- APIX Step 5: Subscribe ------------------------------------------ */
  subscribe: function () {
    // Register the topic on the server (so the engine can evaluate it) and the
    // Subscription itself (POSTed through the client → an 'io' entry).
    if (APIX.server) {
      APIX.server.registerTopic(APIX.seed.topicStatus);
      APIX.server.registerTopic(APIX.seed.topicCreate);
    }
    var sub = APIX.seed.subscription;
    APIX.client.createSubscription(sub);
    if (APIX.server) APIX.server.registerSubscription(sub);
    this.subscriptions.push(sub);
    this.put(sub);
  },

  /* ---- Regulator advances the Task; fires notifications ---------------- */
  updateTask: function (effect) {
    var self = this;
    this.task.status = effect.status;
    this.task.businessStatus = { coding: [{ system: APIX.SYS.businessStatus, code: effect.businessStatus, display: APIX.display('businessStatus', effect.businessStatus) }] };
    var nowIso = new Date().toISOString();
    this.task.lastModified = nowIso;

    if (effect.addProcedureNo) {
      this.task.identifier.push({ use: 'official', type: { coding: [{ system: APIX.SYS.idType, code: 'apixregulatorprocedureno', display: 'APIX Regulator Procedure Number' }] }, system: APIX.SYS.procedureSystem, value: 'PROC-2026-04210' });
    }
    if (effect.addOutputs) {
      this.task.output = this.task.output || [];
      effect.addOutputs.forEach(function (k) {
        var o = APIX.OUTPUTS[k];
        var dref = self._docref(o.id, o.ctd, 'application/pdf', o.title, 'Binary/binary-' + o.id);
        dref.author = [{ reference: 'Organization/' + APIX.seed.regulator.id }];
        self.put(APIX.client.create(dref, { label: 'Regulator output — ' + o.title }));
        self.task.output.push({ type: { coding: [{ system: APIX.SYS.ctd, code: o.ctd, display: APIX.display('ctd', o.ctd) }] }, valueReference: { reference: 'DocumentReference/' + o.id, display: o.title } });
      });
    }

    // PUT the updated Task. The server bumps meta.versionId + lastUpdated and,
    // because status changed, fires the status-change topic → delivers a
    // subscription-notification → our delivery listener emits 'notification'.
    var stored = APIX.client.update(this.task, { label: 'Task → ' + effect.status + ' / ' + APIX.display('businessStatus', effect.businessStatus) });
    this.task = stored;          // adopt server meta (versionId bumped by server)
    this.put(stored);
    this.bus.dispatchEvent(new CustomEvent('task', { detail: { task: this.task, firstTime: false } }));
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
