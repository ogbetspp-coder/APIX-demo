/*
 * In-browser FHIR R5 store + event bus — the "server" for the self-contained
 * demo. Exposes a small surface (connect / submit / subscribe / updateTask) so
 * a real-HAPI REST adapter could be dropped in later behind the same interface.
 *
 * Emits CustomEvents on `bus`:
 *   'wire'         { entry }                  -> a FHIR interaction for the wire feed
 *   'task'         { task, firstTime }        -> Task created/updated
 *   'notification' { bundle, businessStatus, taskStatus, seq } -> real-time push
 *   'reset'        {}                         -> cleared
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
  resources: {},
  bus: new EventTarget(),
  subscriptions: [],
  eventCount: 0,
  seq: 0,
  token: null,
  task: null,
  submissionInputs: [],

  reset: function () {
    this.resources = {};
    this.subscriptions = [];
    this.eventCount = 0;
    this.seq = 0;
    this.token = null;
    this.task = null;
    this.submissionInputs = [];
    this.bus.dispatchEvent(new CustomEvent('reset'));
  },

  /* Emit one line on the FHIR wire. dir: out|in|reg|sys */
  wire: function (dir, method, url, label, resource) {
    this.seq += 1;
    this.bus.dispatchEvent(new CustomEvent('wire', {
      detail: { seq: this.seq, dir: dir, method: method, url: url, label: label, resource: resource, ts: new Date() }
    }));
  },

  put: function (resource, dir, label, silent) {
    var key = resource.resourceType + '/' + resource.id;
    this.resources[key] = resource;
    if (!silent) this.wire(dir || 'out', 'POST', resource.resourceType, label || resource.resourceType, resource);
    return resource;
  },

  get: function (ref) { return this.resources[ref] || null; },

  /* ---- APIX Step 1: Connect -------------------------------------------- */
  connect: function () {
    this.wire('sys', 'POST', 'token', 'OAuth2 token request (SMART Backend Services)', {
      grant_type: 'client_credentials',
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: 'eyJhbGciOiJSUzI1NiIsImtpZCI6InN5bnRocGhhcm1hLTAxIn0…',
      scope: 'system/Task.cruds system/DocumentReference.cruds system/Binary.cruds system/Subscription.cruds'
    });
    this.token = 'eyJraWQiOiJzeW50aHBoYXJtYS0wMSIsInR5cCI6IkpXVC…';
    this.wire('sys', '200', 'token', 'Access token issued (Bearer, 300s)', {
      access_token: this.token, token_type: 'Bearer', expires_in: 300,
      scope: 'system/Task.cruds system/DocumentReference.cruds system/Binary.cruds system/Subscription.cruds'
    });
    this.put(APIX.seed.applicant, 'out', 'Organization (SynthPharma AG)');
    this.put(APIX.seed.endpoint, 'out', 'Endpoint (notification webhook)');
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
    return {
      resourceType: 'DocumentReference',
      id: id,
      meta: { profile: [APIX.SYS.profile.docref] },
      version: '2.0',
      status: 'current',
      docStatus: 'final',
      type: { coding: [{ system: APIX.SYS.ctd, code: ctd, display: APIX.display('ctd', ctd) }] },
      category: [{ coding: [{ system: APIX.SYS.ctd, code: 'm3', display: 'Module 3 - Quality' }] }],
      subject: { reference: 'MedicinalProductDefinition/' + APIX.seed.product.id },
      author: [{ reference: 'Organization/' + APIX.seed.applicant.id }],
      date: new Date().toISOString(),
      content: [{ attachment: { contentType: contentType, url: url, title: title, size: size || 256000 } }]
    };
  },

  /* ---- APIX Steps 2-4: Stream + Describe + Orchestrate ----------------- */
  submit: function () {
    var self = this;
    var docs = this.buildSubmissionDocs();
    this.submissionInputs = [];

    // Step 2 — Stream each file as Binary
    docs.forEach(function (d) { self.put(d.binary, 'out', 'Binary (' + d.binary.contentType + ')'); });
    // Step 3 — Describe each with a DocumentReference
    docs.forEach(function (d) {
      self.put(d.docref, 'out', 'DocumentReference — ' + d.docref.content[0].attachment.title);
      self.submissionInputs.push({
        type: { coding: [{ system: APIX.SYS.ctd, code: d.docref.type.coding[0].code, display: d.docref.type.coding[0].display }] },
        valueReference: { reference: 'DocumentReference/' + d.docref.id, display: d.docref.content[0].attachment.title }
      });
    });
    // Step 4 — Orchestrate with a Task
    this.task = this.buildTask();
    this.put(this.task, 'out', 'Task — Type IB variation (created)');
    // create-topic: regulator (owner) is notified -> populate its console
    this.bus.dispatchEvent(new CustomEvent('task', { detail: { task: this.task, firstTime: true } }));
    return this.task;
  },

  buildTask: function () {
    return {
      resourceType: 'Task',
      id: APIX.TASK_ID,
      meta: { profile: [APIX.SYS.profile.task] },
      identifier: [{ use: 'official', type: { coding: [{ system: APIX.SYS.idType, code: 'apixtaskinstance', display: 'APIX Task Instance ID' }] }, system: APIX.SYS.taskIdSystem, value: APIX.TASK_UUID }],
      status: 'requested',
      businessStatus: { coding: [{ system: APIX.SYS.businessStatus, code: 'submitted', display: 'Submitted' }] },
      intent: 'proposal',
      priority: 'routine',
      code: { coding: [{ system: APIX.SYS.taskCode, code: 'variation-type-ib', display: 'Type IB Variation' }] },
      description: 'Type IB variation (B.II.d.1): tightening of end-of-shelf-life Water Content limit for ' + APIX.seed.product.name[0].productName,
      focus: { reference: 'MedicinalProductDefinition/' + APIX.seed.product.id, display: APIX.seed.product.name[0].productName },
      authoredOn: new Date().toISOString(),
      lastModified: new Date().toISOString(),
      requester: { reference: 'Organization/' + APIX.seed.applicant.id, display: 'SynthPharma AG' },
      owner: { reference: 'Organization/' + APIX.seed.regulator.id, display: 'Health Authority' },
      input: this.submissionInputs
    };
  },

  /* ---- APIX Step 5: Subscribe ------------------------------------------ */
  subscribe: function () {
    this.put(APIX.seed.topicStatus, 'out', 'SubscriptionTopic (status change)', true);
    var sub = APIX.seed.subscription;
    this.subscriptions.push(sub);
    this.put(sub, 'out', 'Subscription (rest-hook, Task status changes)');
  },

  /* ---- Regulator advances the Task; fires notifications ---------------- */
  updateTask: function (effect) {
    var self = this;
    var prevStatus = this.task.status;
    this.task.status = effect.status;
    this.task.businessStatus = { coding: [{ system: APIX.SYS.businessStatus, code: effect.businessStatus, display: APIX.display('businessStatus', effect.businessStatus) }] };
    this.task.lastModified = new Date().toISOString();

    if (effect.addProcedureNo) {
      this.task.identifier.push({ use: 'official', type: { coding: [{ system: APIX.SYS.idType, code: 'apixregulatorprocedureno', display: 'APIX Regulator Procedure Number' }] }, system: APIX.SYS.procedureSystem, value: 'PROC-2026-04210' });
    }
    if (effect.addOutputs) {
      this.task.output = this.task.output || [];
      effect.addOutputs.forEach(function (k) {
        var o = APIX.OUTPUTS[k];
        var dref = self._docref(o.id, o.ctd, 'application/pdf', o.title, 'Binary/binary-' + o.id);
        dref.author = [{ reference: 'Organization/' + APIX.seed.regulator.id }];
        self.put(dref, 'reg', 'DocumentReference — ' + o.title + ' (regulator output)');
        self.task.output.push({ type: { coding: [{ system: APIX.SYS.ctd, code: o.ctd, display: o.title }] }, valueReference: { reference: 'DocumentReference/' + o.id, display: o.title } });
      });
    }

    // PUT the updated Task
    this.resources['Task/' + this.task.id] = this.task;
    this.wire('reg', 'PUT', 'Task/' + this.task.id, 'Task updated → ' + effect.status + ' / ' + APIX.display('businessStatus', effect.businessStatus), this.task);
    this.bus.dispatchEvent(new CustomEvent('task', { detail: { task: this.task, firstTime: false } }));

    // Topic trigger: %previous.status != %current.status
    if (prevStatus !== effect.status && this.subscriptions.length) {
      var bundle = this.buildNotificationBundle(effect.status, effect.businessStatus);
      setTimeout(function () {
        self.wire('in', 'POST', 'notification', 'Subscription notification → SynthPharma webhook', bundle);
        self.bus.dispatchEvent(new CustomEvent('notification', {
          detail: { bundle: bundle, businessStatus: effect.businessStatus, taskStatus: effect.status, seq: self.eventCount }
        }));
      }, 700);
    }
  },

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
