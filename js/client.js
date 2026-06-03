/*
 * APIX.client — a thin FHIR client that sits between the app/store and a
 * backend. It builds a real REST request { method, url, headers, body },
 * dispatches it to the active adapter, and emits a single 'io' event carrying
 * the matched request⇄response pair so a UI inspector can render the wire.
 *
 * Backends (selected by APIX.config.backend):
 *   'mock' → APIX.server.request(...) (synchronous, in-memory; the demo default)
 *   'hapi' → fetch(APIX.config.hapiBase + url, ...) (real; async, optional)
 *
 * Every method returns a PROMISE that resolves to the response BODY (the
 * resource / Bundle / Parameters); the full { request, response } pair rides on
 * the 'io' event. The mock adapter is synchronous under the hood, but its result
 * is wrapped in Promise.resolve(...) so the surface is UNIFORMLY async — the
 * same store/app code drives both the mock and the real (fetch) HAPI backend.
 *
 *   'io' detail = {
 *     id,        // incrementing int, unique per interaction
 *     label,     // short human string, e.g. "Stream document (Binary)"
 *     request:  { method, url, headers, body },
 *     response: { status, statusText, headers, body },
 *     ts         // Date
 *   }
 */
window.APIX = window.APIX || {};

APIX.FhirClient = function () {
  this.bus = new EventTarget();
  this._seq = 0;
};

(function (proto) {

  function defaultHeaders(body) {
    var h = { 'Accept': 'application/fhir+json' };
    if (body != null) h['Content-Type'] = 'application/fhir+json';
    return h;
  }

  /* ---- adapters -------------------------------------------------------- */
  // Synchronous mock adapter.
  proto._mock = function (request) {
    return APIX.server.request(request.method, request.url, request.body, request.headers);
  };

  // Real HAPI adapter. Wired but optional — returns a Promise. The scripted
  // demo runs on 'mock', so this path is exercised only for a real backend
  // ('hapi' = public HAPI, 'local' = self-hosted Docker HAPI). The base URL is
  // resolved per-backend via APIX.config.activeBase().
  proto._hapi = function (request) {
    var base = (APIX.config.activeBase ? APIX.config.activeBase() : APIX.config.hapiBase);
    var url = base + request.url;
    var init = { method: request.method, headers: request.headers };
    if (request.body != null) init.body = JSON.stringify(request.body);
    return fetch(url, init).then(function (resp) {
      return resp.text().then(function (text) {
        var body = null;
        try { body = text ? JSON.parse(text) : null; } catch (e) { body = text; }
        var headers = {};
        if (resp.headers && resp.headers.forEach) resp.headers.forEach(function (v, k) { headers[k] = v; });
        return { status: resp.status, statusText: resp.statusText, headers: headers, body: body };
      });
    });
  };

  // Any real-server backend ('hapi' public or 'local' self-hosted) uses fetch();
  // 'mock' uses the in-process server. Mock stays the stage-safe default.
  proto._adapter = function () {
    var b = APIX.config && APIX.config.backend;
    return (b === 'hapi' || b === 'local') ? this._hapi : this._mock;
  };

  /* ---- the dispatch core ----------------------------------------------- */
  // Build → dispatch → emit 'io' → resolve to response body. ALWAYS returns a
  // Promise: the mock adapter's synchronous result is wrapped in Promise.resolve
  // so callers can uniformly `await` every method regardless of backend.
  proto._dispatch = function (request, label) {
    var self = this;
    request.headers = request.headers || defaultHeaders(request.body);
    var id = (this._seq += 1);
    var adapter = this._adapter();

    function emit(resp) {
      self.bus.dispatchEvent(new CustomEvent('io', {
        detail: { id: id, label: label, request: request, response: resp, ts: new Date() }
      }));
      return resp;
    }

    // Normalise the adapter result (sync object or Promise) to a Promise, then
    // emit the matched 'io' pair and resolve to the response body.
    return Promise.resolve(adapter.call(this, request))
      .then(emit)
      .then(function (resp) { return resp.body; });
  };

  // Surface an externally-produced interaction (e.g. an inbound subscription
  // delivery, or the simulated OAuth token exchange) as an 'io' event too.
  proto.record = function (label, request, response) {
    var id = (this._seq += 1);
    this.bus.dispatchEvent(new CustomEvent('io', {
      detail: { id: id, label: label, request: request, response: response, ts: new Date() }
    }));
    return response;
  };

  /* ---- FHIR REST surface ----------------------------------------------- */
  proto.create = function (resource, opts) {
    opts = opts || {};
    var label = opts.label || ('Create ' + resource.resourceType);
    return this._dispatch({ method: 'POST', url: '/' + resource.resourceType, body: resource }, label);
  };

  proto.read = function (reference) {
    var label = 'Read ' + reference;
    return this._dispatch({ method: 'GET', url: '/' + reference }, label);
  };

  proto.update = function (resource, opts) {
    opts = opts || {};
    var label = opts.label || ('Update ' + resource.resourceType);
    var headers = defaultHeaders(resource);
    if (resource.meta && resource.meta.versionId) headers['If-Match'] = 'W/"' + resource.meta.versionId + '"';
    return this._dispatch({
      method: 'PUT',
      url: '/' + resource.resourceType + '/' + resource.id,
      headers: headers,
      body: resource
    }, label);
  };

  proto.search = function (type, params) {
    var qs = '';
    if (params && typeof params === 'object') {
      var pairs = [];
      for (var k in params) pairs.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
      qs = pairs.join('&');
    } else if (typeof params === 'string') {
      qs = params;
    }
    var url = '/' + type + (qs ? '?' + qs : '');
    return this._dispatch({ method: 'GET', url: url }, 'Search ' + type);
  };

  proto.validate = function (resource) {
    return this._dispatch({
      method: 'POST',
      url: '/' + resource.resourceType + '/$validate',
      body: resource
    }, 'Validate ' + resource.resourceType + ' ($validate)');
  };

  proto.translate = function (system, code) {
    var params = {
      resourceType: 'Parameters',
      parameter: [
        { name: 'system', valueUri: system },
        { name: 'code', valueCode: code }
      ]
    };
    return this._dispatch({
      method: 'POST',
      url: '/ConceptMap/$translate',
      body: params
    }, 'Translate ' + code + ' ($translate)');
  };

  proto.createSubscription = function (sub) {
    return this._dispatch({ method: 'POST', url: '/' + sub.resourceType, body: sub },
      'Subscribe (' + sub.resourceType + ')');
  };

})(APIX.FhirClient.prototype);

APIX.client = new APIX.FhirClient();

/* Wire server-side notification deliveries through the same 'io' feed: an
 * inbound POST to the subscriber endpoint that returns 200. (js/store.js also
 * re-attaches this on reset, since reset rebuilds APIX.server; both paths use
 * the same idempotent recorder.) */
if (APIX.server) {
  APIX.server.onDeliver = function (detail) {
    APIX.client.record(
      'Notification → subscriber',
      { method: 'POST', url: detail.endpoint || 'Subscription/notify', headers: { 'Content-Type': 'application/fhir+json' }, body: detail.bundle },
      { status: 200, statusText: 'OK', headers: { 'Content-Type': 'application/fhir+json' }, body: null }
    );
  };
}
