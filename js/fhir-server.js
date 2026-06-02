/*
 * APIX.MockFhirServer — a tiny in-memory FHIR R5 server with real request /
 * response semantics, so the demo can show an honest REST conversation and an
 * I/O inspector without any network. It is fully synchronous (a Map is the
 * "database"); js/client.js is the seam that lets the same calls hit a real
 * HAPI endpoint instead.
 *
 * What it models faithfully:
 *   - type-level create (POST {Type})            → 201 + Location + ETag, server id + meta
 *   - instance update  (PUT  {Type}/{id})        → 200 + ETag, versionId bump + history;
 *                                                   optimistic locking via If-Match (412)
 *   - instance read    (GET  {Type}/{id})        → 200 | 404 (OperationOutcome)
 *   - search           (GET  {Type}?params)      → 200 + searchset Bundle
 *   - $validate        (POST {Type}/$validate)   → 200 + OperationOutcome
 *   - $translate       (ConceptMap/$translate)   → 200 + Parameters (R5 shape)
 *
 * Subscription topic engine (no FHIRPath dependency). We implement the exact,
 * narrow subset of criteria the two seeded SubscriptionTopics need:
 *   - topicCreate  (.../TaskCreationWithOrganizationAssignedFilter)
 *       resourceTrigger: Task / supportedInteraction:["create"]
 *       → fires on every Task create.
 *   - topicStatus  (.../TaskStatusChangeWithIdentifierFilter)
 *       resourceTrigger: Task / supportedInteraction:["update"]
 *       fhirPathCriteria: "%previous.status != %current.status"
 *       → fires on a Task update when the status actually changed.
 * Subscription.filterBy (e.g. Task.identifier|<uuid>) is evaluated structurally.
 * On a match we build the R5 subscription-notification Bundle and "deliver" it
 * to the subscriber endpoint (recorded as an inbound POST → 200), then invoke
 * onDeliver(detail) so the client can surface it as an 'io' event.
 */
window.APIX = window.APIX || {};

APIX.MockFhirServer = function () {
  this.db = {};                 // "Type/id" -> { resource, history: [versions] }
  this.subscriptions = [];      // [{ resource, topic }]
  this.topics = {};             // canonical url -> SubscriptionTopic
  this.onDeliver = null;        // primary hook(detail) for notification delivery
  this._deliverListeners = [];  // additional delivery subscribers (store, etc.)
  this.notificationCount = 0;   // running event counter (eventsSinceSubscriptionStart)
};

(function (proto) {

  /* ---- helpers --------------------------------------------------------- */
  function nowIso() { return new Date().toISOString(); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function outcome(severity, code, diagnostics) {
    return {
      resourceType: 'OperationOutcome',
      issue: [{ severity: severity, code: code, diagnostics: diagnostics }]
    };
  }

  // Split "/Type/id/_history/v" style paths; tolerate an optional query string.
  function parseUrl(url) {
    var u = String(url || '');
    var q = '';
    var qi = u.indexOf('?');
    if (qi >= 0) { q = u.slice(qi + 1); u = u.slice(0, qi); }
    u = u.replace(/^\/+/, '').replace(/\/+$/, '');
    return { segments: u.length ? u.split('/') : [], query: q };
  }

  proto.key = function (type, id) { return type + '/' + id; };

  proto.exists = function (type, id) {
    return Object.prototype.hasOwnProperty.call(this.db, this.key(type, id));
  };

  /* ---- store primitives ------------------------------------------------ */
  proto._insert = function (resource) {
    var stored = clone(resource);
    stored.meta = stored.meta || {};
    stored.meta.versionId = '1';
    stored.meta.lastUpdated = nowIso();
    this.db[this.key(stored.resourceType, stored.id)] = { resource: stored, history: [] };
    return stored;
  };

  proto._replace = function (resource) {
    var k = this.key(resource.resourceType, resource.id);
    var entry = this.db[k];
    var prior = entry ? entry.resource : null;
    var next = clone(resource);
    next.meta = next.meta || {};
    if (entry) {
      // Update existing: bump versionId (n+1), archive the prior version.
      var curV = parseInt(prior.meta.versionId, 10) || 1;
      next.meta.versionId = String(curV + 1);
      next.meta.lastUpdated = nowIso();
      entry.history.unshift(prior);
      entry.resource = next;
    } else {
      // PUT to a fresh id: behaves like a client-assigned create at version 1.
      next.meta.versionId = '1';
      next.meta.lastUpdated = nowIso();
      this.db[k] = { resource: next, history: [] };
    }
    return { resource: next, previous: prior };
  };

  /* ---- the one entry point --------------------------------------------- */
  // request(method, url, body, headers) -> { status, statusText, headers, body }
  proto.request = function (method, url, body, headers) {
    method = String(method || 'GET').toUpperCase();
    headers = headers || {};
    var parsed = parseUrl(url);
    var seg = parsed.segments;
    var type = seg[0];

    // ---- Operations (contain a $ segment) ----
    var opSeg = seg[seg.length - 1] || '';
    if (opSeg.charAt(0) === '$' || (seg[0] && seg[0].charAt(0) === '$')) {
      return this._operation(method, type, opSeg, parsed.query, body);
    }

    // ---- type-level ----
    if (seg.length === 1) {
      if (method === 'POST') return this._create(type, body);
      if (method === 'GET')  return this._search(type, parsed.query);
      return this._status(405, 'Method Not Allowed', outcome('error', 'not-supported', method + ' not supported on ' + type));
    }

    // ---- instance-level ({Type}/{id}) ----
    if (seg.length >= 2) {
      var id = seg[1];
      if (method === 'GET')  return this._read(type, id);
      if (method === 'PUT')  return this._update(type, id, body, headers);
      if (method === 'DELETE') return this._delete(type, id);
      return this._status(405, 'Method Not Allowed', outcome('error', 'not-supported', method + ' not supported'));
    }

    return this._status(400, 'Bad Request', outcome('error', 'invalid', 'Unparseable request URL: ' + url));
  };

  proto._status = function (status, statusText, body, extraHeaders) {
    var h = { 'Content-Type': 'application/fhir+json' };
    if (extraHeaders) for (var k in extraHeaders) h[k] = extraHeaders[k];
    // Always hand back a defensive copy so a caller can never mutate the
    // server's stored state in place (mirrors a real HTTP boundary). This is
    // what keeps versionId bumps + topic %previous.status comparisons honest.
    var out = (body && typeof body === 'object') ? clone(body) : body;
    return { status: status, statusText: statusText, headers: h, body: out };
  };

  /* ---- CRUD ------------------------------------------------------------ */
  proto._create = function (type, body) {
    if (!body || typeof body !== 'object') {
      return this._status(400, 'Bad Request', outcome('error', 'invalid', 'Missing request body for create.'));
    }
    var resource = clone(body);
    resource.resourceType = resource.resourceType || type;
    if (!resource.id) resource.id = APIX.uuid();
    var stored = this._insert(resource);
    var loc = '/' + stored.resourceType + '/' + stored.id + '/_history/' + stored.meta.versionId;
    var res = this._status(201, 'Created', stored, {
      'Location': loc,
      'ETag': 'W/"' + stored.meta.versionId + '"',
      'Last-Modified': stored.meta.lastUpdated
    });
    // Topic engine: a create may fire creation topics.
    this._fireTopics('create', stored, null);
    return res;
  };

  proto._read = function (type, id) {
    var entry = this.db[this.key(type, id)];
    if (!entry) return this._status(404, 'Not Found', outcome('error', 'not-found', type + '/' + id + ' not found.'));
    return this._status(200, 'OK', entry.resource, {
      'ETag': 'W/"' + entry.resource.meta.versionId + '"',
      'Last-Modified': entry.resource.meta.lastUpdated
    });
  };

  proto._update = function (type, id, body, headers) {
    if (!body || typeof body !== 'object') {
      return this._status(400, 'Bad Request', outcome('error', 'invalid', 'Missing request body for update.'));
    }
    var k = this.key(type, id);
    var entry = this.db[k];

    // Optimistic locking: If-Match must equal the current versionId.
    var ifMatch = headers['If-Match'] || headers['if-match'];
    if (ifMatch != null && entry) {
      var want = String(ifMatch).replace(/^W\//, '').replace(/"/g, '').trim();
      var have = String(entry.resource.meta.versionId);
      if (want !== have) {
        return this._status(412, 'Precondition Failed',
          outcome('error', 'conflict', 'Version conflict: If-Match "' + want + '" does not match current versionId "' + have + '".'),
          { 'ETag': 'W/"' + have + '"' });
      }
    }

    var resource = clone(body);
    resource.resourceType = type;
    resource.id = id;
    var result = this._replace(resource);
    var stored = result.resource;
    var res = this._status(200, 'OK', stored, {
      'ETag': 'W/"' + stored.meta.versionId + '"',
      'Last-Modified': stored.meta.lastUpdated,
      'Location': '/' + type + '/' + id + '/_history/' + stored.meta.versionId
    });
    // Topic engine: an update may fire status-change topics.
    this._fireTopics('update', stored, result.previous);
    return res;
  };

  proto._delete = function (type, id) {
    var k = this.key(type, id);
    if (!this.db[k]) return this._status(404, 'Not Found', outcome('error', 'not-found', type + '/' + id + ' not found.'));
    delete this.db[k];
    return this._status(204, 'No Content', null);
  };

  proto._search = function (type, query) {
    var self = this;
    var matches = [];
    Object.keys(this.db).forEach(function (k) {
      if (k.indexOf(type + '/') === 0) matches.push(self.db[k].resource);
    });
    var bundle = {
      resourceType: 'Bundle',
      type: 'searchset',
      timestamp: nowIso(),
      total: matches.length,
      link: [{ relation: 'self', url: '/' + type + (query ? '?' + query : '') }],
      entry: matches.map(function (r) {
        return {
          fullUrl: '/' + r.resourceType + '/' + r.id,
          resource: clone(r),
          search: { mode: 'match' }
        };
      })
    };
    return this._status(200, 'OK', bundle);
  };

  /* ---- operations ------------------------------------------------------ */
  proto._operation = function (method, type, op, query, body) {
    op = op.toLowerCase();
    if (op === '$validate') {
      return this._status(200, 'OK', outcome('information', 'informational',
        'Resource conforms to FHIR R5 (mock validation).'));
    }
    if (op === '$translate') {
      return this._translate(query, body);
    }
    return this._status(404, 'Not Found', outcome('error', 'not-supported', 'Operation ' + op + ' is not supported by the mock server.'));
  };

  // Build the R5 ConceptMap/$translate result as a Parameters resource.
  proto._translate = function (query, body) {
    var system = null, code = null;
    // GET ?system=&code=
    if (query) {
      query.split('&').forEach(function (pair) {
        var kv = pair.split('=');
        var name = decodeURIComponent(kv[0] || '');
        var val = decodeURIComponent((kv[1] || '').replace(/\+/g, ' '));
        if (name === 'system') system = val;
        else if (name === 'code') code = val;
      });
    }
    // POST Parameters body
    if ((!system || !code) && body && body.parameter) {
      body.parameter.forEach(function (p) {
        if (p.name === 'system') system = p.valueUri || p.valueString || system;
        else if (p.name === 'code') code = p.valueCode || p.valueString || code;
        else if (p.name === 'coding' && p.valueCoding) {
          system = system || p.valueCoding.system;
          code = code || p.valueCoding.code;
        }
      });
    }

    var match = (APIX.terminology && system && code) ? APIX.terminology.translate(system, code) : null;
    var params = { resourceType: 'Parameters', parameter: [] };
    if (match) {
      params.parameter.push({ name: 'result', valueBoolean: true });
      params.parameter.push({
        name: 'match',
        part: [
          { name: 'relationship', valueCode: match.relationship },
          { name: 'concept', valueCoding: { system: match.system, code: match.code, display: match.display } }
        ]
      });
    } else {
      params.parameter.push({ name: 'result', valueBoolean: false });
      params.parameter.push({ name: 'message', valueString: 'No mapping found for ' + (system || '?') + '|' + (code || '?') + '.' });
    }
    return this._status(200, 'OK', params);
  };

  /* ---- subscriptions + topic engine ------------------------------------ */
  proto.registerTopic = function (topic) {
    if (topic && topic.url) this.topics[topic.url] = clone(topic);
    return topic;
  };

  proto.registerSubscription = function (subscription) {
    var sub = clone(subscription);
    this.subscriptions.push({ resource: sub, topic: sub.topic });
    return sub;
  };

  // The narrow, FHIRPath-free criteria evaluator for the two seeded topics.
  proto._topicFires = function (topic, interaction, current, previous) {
    if (!topic || !topic.resourceTrigger) return false;
    return topic.resourceTrigger.some(function (rt) {
      if (rt.resource && rt.resource !== current.resourceType) return false;
      var supports = (rt.supportedInteraction || []).indexOf(interaction) >= 0;
      if (!supports) return false;
      // The only fhirPathCriteria we implement: "%previous.status != %current.status".
      if (rt.fhirPathCriteria && /previous\.status\s*!=\s*%current\.status/.test(rt.fhirPathCriteria)) {
        return !!previous && previous.status !== current.status;
      }
      return true; // create-trigger (no criteria) fires on the interaction alone.
    });
  };

  // Structural evaluation of Subscription.filterBy (Task.identifier|<uuid> etc.).
  proto._subscriptionMatches = function (sub, current) {
    if (!sub.filterBy || !sub.filterBy.length) return true;
    return sub.filterBy.every(function (f) {
      if (f.resourceType && f.resourceType !== current.resourceType) return false;
      if (f.filterParameter === 'identifier' && f.value) {
        var parts = String(f.value).split('|');
        var wantSystem = parts.length > 1 ? parts[0] : null;
        var wantValue = parts.length > 1 ? parts[1] : parts[0];
        return (current.identifier || []).some(function (idf) {
          return idf.value === wantValue && (!wantSystem || idf.system === wantSystem);
        });
      }
      if (f.filterParameter === 'owner' && f.value && current.owner) {
        return current.owner.reference === f.value || current.owner.reference === ('Organization/' + f.value);
      }
      return true; // unknown filter → permissive (demo subset).
    });
  };

  // On create/update, evaluate every subscription's topic and deliver matches.
  proto._fireTopics = function (interaction, current, previous) {
    var self = this;
    this.subscriptions.forEach(function (rec) {
      if (!rec.resource || rec.resource.status !== 'active') return;
      var topic = self.topics[rec.topic];
      if (!topic) return;
      if (!self._topicFires(topic, interaction, current, previous)) return;
      if (!self._subscriptionMatches(rec.resource, current)) return;
      self._deliver(rec.resource, topic, current);
    });
  };

  proto._deliver = function (sub, topic, focus) {
    this.notificationCount += 1;
    var n = String(this.notificationCount);
    var ts = nowIso();
    var bundle = {
      resourceType: 'Bundle',
      id: 'notif-' + n,
      type: 'subscription-notification',
      timestamp: ts,
      entry: [
        {
          fullUrl: 'urn:uuid:status-' + n,
          resource: {
            resourceType: 'SubscriptionStatus',
            status: 'active',
            type: 'event-notification',
            eventsSinceSubscriptionStart: n,
            notificationEvent: [{ eventNumber: n, timestamp: ts, focus: { reference: focus.resourceType + '/' + focus.id } }],
            subscription: { reference: 'Subscription/' + sub.id },
            topic: topic.url
          }
        },
        {
          fullUrl: 'https://api.health-authority.example/fhir/' + focus.resourceType + '/' + focus.id,
          resource: clone(focus),
          request: { method: 'PUT', url: focus.resourceType + '/' + focus.id }
        }
      ]
    };

    // "Deliver" to the subscriber endpoint: record an inbound POST → 200.
    var businessStatus = (focus.businessStatus && focus.businessStatus.coding && focus.businessStatus.coding[0])
      ? focus.businessStatus.coding[0].code : null;
    var detail = {
      bundle: bundle,
      businessStatus: businessStatus,
      taskStatus: focus.status,
      endpoint: sub.endpoint,
      response: { status: 200, statusText: 'OK' }
    };
    if (typeof this.onDeliver === 'function') this.onDeliver(detail);
    this._deliverListeners.forEach(function (fn) { try { fn(detail); } catch (e) { /* isolate listeners */ } });
    return detail;
  };

  // Register an extra delivery listener (does not displace onDeliver).
  proto.onDelivery = function (fn) {
    if (typeof fn === 'function') this._deliverListeners.push(fn);
    return fn;
  };

})(APIX.MockFhirServer.prototype);

APIX.server = new APIX.MockFhirServer();
