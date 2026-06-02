/*
 * UI controller — act-based, presentation-grade. Drives the presenter-paced
 * scenario across three acts (Author → Send → Review & track), keeps the raw
 * FHIR one click away ("View { }"), and makes the Subscription feedback loop
 * visually explicit. The FHIR data layer (APIX.store) is unchanged.
 */
(function () {
  var store = APIX.store;
  var S = APIX.scenario;
  var i = 0;                 // current step index
  var reviewDone = {};       // regulator review checklist progress
  var reached = {};          // applicant tracker milestones
  var lastNotif = null;      // most recent notification Bundle (for peek)
  var apixDrawn = false;

  var APIX_STEPS = ['Connect', 'Stream', 'Describe', 'Orchestrate', 'Subscribe'];
  var REVIEW = [
    { key: 'receive', label: 'Acknowledge receipt' },
    { key: 'validate', label: 'Validate submission' },
    { key: 'assess', label: 'Scientific assessment' },
    { key: 'approve', label: 'Decision' }
  ];

  /* Plain-language phrasing for each businessStatus the regulator pushes back —
     used by the spelled-out Industry ⇄ Health Authority conversation log. */
  var BIZ_PLAIN = {
    'received': 'Acknowledged receipt — status now Received',
    'validation-successful': 'Validation successful — submission accepted for assessment',
    'under-assessment': 'Under assessment — scientific review has started',
    'approved': 'Approved — positive decision, approval letter attached',
    'rejected': 'Rejected — negative decision',
    'validation-failed': 'Validation failed — submission cannot be accepted',
    'clock-stop': 'Clock stopped — awaiting further information',
    'decision-pending': 'Decision pending'
  };
  function bizPlain(code) { return BIZ_PLAIN[code] || APIX.display('businessStatus', code); }

  var ioEntries = [];        // captured { } request/response interactions
  var ioOpen = false;        // inspector drawer expanded?

  function el(id) { return document.getElementById(id); }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function bytes(n) { return n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.round(n / 1e3) + ' KB'; }
  function actOf(step) {
    var t = step.effect.type;
    if (t === 'pull' || t === 'normalize' || t === 'render') return 1;
    if (t === 'connect' || t === 'submit' || t === 'subscribe') return 2;
    return 3;
  }

  /* ---- views + stepper -------------------------------------------------- */
  function showView(act) {
    el('view-author').hidden = (act !== 1);
    if (act !== 1 && el('view-exchange').hidden) {
      el('view-exchange').hidden = false;
      if (!apixDrawn) { drawApixSteps(); apixDrawn = true; }
    }
  }
  function setStepper(act) {
    [].forEach.call(el('stepper').children, function (li) {
      var a = +li.getAttribute('data-act');
      li.classList.toggle('active', a === act);
      li.classList.toggle('done', a < act);
    });
  }

  /* ---- controls / step engine ------------------------------------------ */
  function refreshControls() {
    var step = S[i];
    if (step) {
      el('narration').textContent = step.narration;
      el('stepbtn').innerHTML = step.button + ' ▶';
      el('stepbtn').disabled = false;
      el('progress').textContent = 'Step ' + (i + 1) + ' / ' + S.length;
    } else {
      el('narration').innerHTML = '✅ <strong>Approved — end to end in minutes.</strong> Every status change was timestamped (your cycle-time analytics), and APIX carried both the PDF and the structured FHIR over the same rails.';
      el('stepbtn').innerHTML = 'Done'; el('stepbtn').disabled = true;
      el('progress').textContent = 'Complete';
      setStepper(4);
    }
    renderReview();
  }

  function runStep() {
    var step = S[i];
    if (!step) return;
    var act = actOf(step);
    showView(act); setStepper(act);
    if (act === 3) el('review').hidden = false;

    switch (step.effect.type) {
      case 'pull': handlePull(); break;
      case 'normalize': handleNormalize(); break;
      case 'render': handleConsolidate(); break;
      case 'connect': handleConnect(); break;
      case 'submit': handleSubmit(); break;
      case 'subscribe': handleSubscribe(); break;
      case 'updateTask':
        if (step.effect.flexibility) el('reg-flex').hidden = false;
        store.updateTask(step.effect);
        reviewDone[step.key] = true;
        break;
    }
    i += 1;
    refreshControls();
  }
  function show(id) { el(id).hidden = false; }

  /* ---- ACT 1 ------------------------------------------------------------ */
  function handlePull() {
    show('b-sources');
    el('sources').innerHTML = APIX.pqi.sources.map(function (s) {
      return '<div class="src"><div class="src-head"><span class="src-name">' + esc(s.system) +
        '</span><span class="tag">' + esc(s.tag) + '</span></div><div class="src-note">' + esc(s.note) +
        '</div><pre class="src-rows">' + esc(s.rows.join('\n')) + '</pre></div>';
    }).join('');
  }
  /* Friendly relationship phrasing for a ConceptMap target.relationship. */
  function relText(rel) {
    if (rel === 'equivalent') return 'equivalent';
    if (rel === 'source-is-narrower-than-target') return 'narrower → broader';
    if (rel === 'source-is-broader-than-target') return 'broader → narrower';
    return esc(rel);
  }
  /* Act 1 · Harmonize — reveal each ConceptMap mapping one row at a time and
     fire a real ConceptMap/$translate per row (visible in the I/O inspector). */
  function handleNormalize() {
    show('a-normalize'); show('b-spec');
    var rows = APIX.terminology.rows();
    var host = el('harmonize');
    host.innerHTML = '';
    rows.forEach(function (r, n) {
      var div = document.createElement('div');
      div.className = 'hmap';
      div.innerHTML =
        '<span class="hm-src">' + esc(r.source.display) + ' <code>(' + esc(r.source.code) + ')</code></span>' +
        '<span class="hm-gate">⟨ConceptMap⟩</span>' +
        '<span class="hm-tgt">' + esc(r.target.display) + ' <code>(' + esc(r.target.code) + ')</code></span>' +
        '<span class="hm-rel">' + relText(r.relationship) + '</span>';
      host.appendChild(div);
      (function (row, node) {
        setTimeout(function () {
          node.classList.add('in');
          APIX.client.translate(row.source.system, row.source.code);
        }, 250 * n + 120);
      })(r, div);
    });
  }
  /* Act 1 · Consolidate — one card for the finished spec with a Document/FHIR
     toggle (Document = rendered eCTD; FHIR = highlighted PQI Bundle). */
  function renderConsolidated(mode) {
    var body = mode === 'fhir'
      ? '<pre class="modal-json cons-json">' + APIX.highlight(APIX.pqi.bundle) + '</pre>'
      : '<div class="cons-doc">' + APIX.pqi.renderSpecHtml() + '</div>';
    el('consolidated').innerHTML =
      '<div class="cons-card">' +
        '<div class="cons-top">' +
          '<div class="cons-title">Consolidated specification — Velexa 175&nbsp;mg</div>' +
          '<div class="seg" id="cons-seg">' +
            '<button class="seg-btn' + (mode !== 'fhir' ? ' on' : '') + '" data-mode="doc">📄 Document</button>' +
            '<button class="seg-btn' + (mode === 'fhir' ? ' on' : '') + '" data-mode="fhir">{ } FHIR</button>' +
          '</div>' +
        '</div>' +
        '<p class="cons-change">Change in this variation: <strong>' + esc(APIX.pqi.CHANGE.label) + '</strong> — ' +
          '<span class="diff-old">' + esc(APIX.pqi.CHANGE.before) + '</span> → <span class="diff-new">' + esc(APIX.pqi.CHANGE.after) + '</span></p>' +
        '<div class="cons-body">' + body + '</div>' +
      '</div>';
  }
  function handleConsolidate() {
    APIX.pqi.normalize();
    show('a-render'); show('b-formats');
    renderConsolidated('doc');
  }

  /* ---- ACT 2 ------------------------------------------------------------ */
  function drawApixSteps() {
    el('apixsteps').innerHTML = APIX_STEPS.map(function (s, n) {
      return '<div class="astep" id="astep-' + n + '"><span class="tick">✓</span>' + esc(s) + '</div>';
    }).join('');
  }
  function markApix(name) {
    var n = APIX_STEPS.indexOf(name);
    if (n >= 0) el('astep-' + n).classList.add('done');
  }
  function flyChip(text, dir) {
    var c = document.createElement('div');
    c.className = 'chip-fly ' + dir;
    c.textContent = text;
    el('lane').appendChild(c);
    setTimeout(function () { if (c.parentNode) c.parentNode.removeChild(c); }, 1200);
  }
  function docsHtml(inputs) {
    return inputs.map(function (inp) {
      var d = store.get(inp.valueReference.reference);
      var ct = d ? d.content[0].attachment.contentType : 'application/pdf';
      var size = d ? d.content[0].attachment.size : 0;
      var spec = inp.type.coding[0].code === '3.2.P.5.1';
      var ic = ct === 'application/fhir+json' ? '{ }' : '📄';
      return '<div class="doc' + (spec ? ' doc-spec' : '') + '"><span class="doc-ic">' + ic + '</span>' +
        '<span class="doc-ct">' + esc(inp.type.coding[0].code) + '</span>' +
        '<span class="doc-title">' + esc(inp.valueReference.display) + '</span>' +
        '<span class="doc-size">' + bytes(size) + '</span>' +
        '<button class="peek" data-peek="' + inp.valueReference.reference + '">View</button></div>';
    }).join('');
  }
  function handleConnect() {
    store.connect();
    el('conn').className = 'conn connected';
    el('conn').innerHTML = '<span class="dot"></span> Connected · Bearer token · Organization + Endpoint registered';
    markApix('Connect');
  }
  function handleSubmit() {
    store.submit();
    var t = store.task;
    el('pkg').hidden = false;
    el('pkg').innerHTML = '<div class="pkg-head">Submission package · ' + t.input.length +
      ' documents <button class="peek" data-peek="Task">View Task { }</button></div>' + docsHtml(t.input);
    markApix('Stream'); markApix('Describe'); markApix('Orchestrate');
    flyChip('📦 ' + t.input.length + ' documents →', 'right');
    setTimeout(revealRegulator, 950);
  }
  function revealRegulator() {
    el('inbox-empty').hidden = true; el('reg').hidden = false;
    el('reg-docs').innerHTML = '<div class="payload-head">Received documents</div>' + docsHtml(store.task.input);
    updateRegStatus(store.task);
  }
  function handleSubscribe() {
    store.subscribe();
    markApix('Subscribe');
    el('loopnote').hidden = false;
    el('tracker').hidden = false;
    renderTracker('submitted');
  }

  /* ---- ACT 3 ------------------------------------------------------------ */
  function updateRegStatus(task) {
    el('reg-status').innerHTML = '<span class="rs-label">Task status</span>' +
      '<span class="badge badge-status">' + esc(task.status) + '</span>' +
      '<span class="badge badge-biz">' + esc(task.businessStatus.coding[0].display) + '</span>' +
      (task.identifier.length > 1 ? '<span class="badge badge-proc">' + esc(task.identifier[1].value) + '</span>' : '');
    if (task.output && task.output.length) {
      el('reg-outputs').innerHTML = '<div class="payload-head">Outputs sent back</div>' +
        task.output.map(function (o) {
          return '<div class="doc"><span class="doc-ic">📄</span><span class="doc-title">' + esc(o.valueReference.display) + '</span></div>';
        }).join('');
    }
  }
  function renderReview() {
    if (el('review').hidden) return;
    var next = S[i];
    var activeKey = (next && actOf(next) === 3) ? next.key : null;
    el('review').innerHTML = '<div class="review-head">Regulatory review</div>' + REVIEW.map(function (it) {
      var cls = 'ritem' + (reviewDone[it.key] ? ' done' : '') + (it.key === activeKey ? ' active' : '');
      return '<div class="' + cls + '"><span class="rdot">' + (reviewDone[it.key] ? '✓' : '') + '</span>' + esc(it.label) + '</div>';
    }).join('');
  }
  function renderTracker(markCode, justNow) {
    if (markCode) reached[markCode] = new Date();
    el('tracker').innerHTML = '<div class="tracker-head">Live submission tracking ' +
      (lastNotif ? '<button class="peek" data-peek="notif">last notification { }</button>' : '') + '</div>' +
      APIX.businessStatusFlow.map(function (m) {
        var done = !!reached[m.code];
        var ts = done ? reached[m.code].toLocaleTimeString() : '';
        return '<div class="tnode ' + (done ? 'done' : '') + (m.code === justNow ? ' just' : '') + '">' +
          '<span class="tdot">' + (done ? m.icon : '○') + '</span><span class="tlbl">' + esc(m.label) +
          '</span><span class="tts">' + ts + '</span></div>';
      }).join('');
  }

  /* ---- conversation log (Industry ⇄ Health Authority) ------------------- */
  /* Append one plain-language exchange line, with explicit direction and an
     optional "view { }" peek to the underlying FHIR resource/Bundle. */
  function convLine(dir, from, to, text, peek) {
    el('conversation').hidden = false;
    var row = document.createElement('div');
    row.className = 'conv-row ' + dir;
    row.innerHTML =
      '<span class="conv-dir">' + from + ' <span class="conv-arrow">→</span> ' + to + '</span>' +
      '<span class="conv-msg">' + text + '</span>' +
      (peek ? '<button class="conv-peek peek" data-peek="' + esc(peek) + '">view { }</button>' : '');
    el('conv-log').appendChild(row);
    el('conv-log').scrollTop = el('conv-log').scrollHeight;
  }

  /* ---- I/O inspector (real request/response inspector) ------------------ */
  function ioStatusClass(status) {
    if (status >= 200 && status < 300) return 'ok';
    if (status >= 400) return 'err';
    return 'neu';
  }
  function ioHeaderRows(h) {
    if (!h) return '';
    var keep = ['Content-Type', 'Accept', 'If-Match', 'Location', 'ETag', 'Last-Modified', 'Authorization'];
    var out = [];
    Object.keys(h).forEach(function (k) {
      for (var n = 0; n < keep.length; n++) {
        if (k.toLowerCase() === keep[n].toLowerCase()) { out.push('<div class="io-h"><span>' + esc(k) + '</span>: ' + esc(String(h[k])) + '</div>'); break; }
      }
    });
    return out.join('');
  }
  function ioBody(b) {
    if (b == null) return '<div class="io-empty">(no body)</div>';
    return '<pre class="modal-json io-json">' + APIX.highlight(b) + '</pre>';
  }
  function renderIoEntry(e) {
    var st = e.response || {};
    var cls = ioStatusClass(st.status);
    var req = e.request || {};
    return '<div class="io-entry" data-io="' + e.id + '">' +
      '<button class="io-sum io-' + cls + '">' +
        '<span class="io-method">' + esc(req.method || '') + '</span>' +
        '<span class="io-url">' + esc(req.url || '') + '</span>' +
        '<span class="io-arrow">→</span>' +
        '<span class="io-status">' + esc(String(st.status || '')) + ' ' + esc(st.statusText || '') + '</span>' +
        '<span class="io-label">' + esc(e.label || '') + '</span>' +
      '</button>' +
      '<div class="io-detail" hidden>' +
        '<div class="io-sec">Request</div>' +
        '<div class="io-line"><span class="io-k">' + esc(req.method || '') + '</span> ' + esc(req.url || '') + '</div>' +
        ioHeaderRows(req.headers) + ioBody(req.body) +
        '<div class="io-sec">Response</div>' +
        '<div class="io-line"><span class="io-k">' + esc(String(st.status || '')) + '</span> ' + esc(st.statusText || '') + '</div>' +
        ioHeaderRows(st.headers) + ioBody(st.body) +
      '</div>' +
    '</div>';
  }
  function setIoCount() { el('io-count').textContent = ioEntries.length; }
  function setDrawer(open) {
    ioOpen = open;
    el('io-drawer').hidden = !open;
    el('io-toggle').setAttribute('aria-expanded', open ? 'true' : 'false');
    el('io-toggle').classList.toggle('on', open);
  }
  function addIo(detail) {
    ioEntries.push(detail);
    setIoCount();
    var wrap = document.createElement('div');
    wrap.innerHTML = renderIoEntry(detail);
    el('io-list').appendChild(wrap.firstChild);
  }

  /* ---- modal / peeks ---------------------------------------------------- */
  function openModal(html) { el('modal-body').innerHTML = html; el('modal').hidden = false; }
  function openJson(title, obj) { openModal('<h2 class="modal-title">' + esc(title) + '</h2><pre class="modal-json">' + APIX.highlight(obj) + '</pre>'); }
  function openDoc(kind) {
    if (kind === 'pdf') openModal('<h2 class="modal-title">📄 Rendered eCTD 3.2.P.5.1 (PDF view)</h2>' + APIX.pqi.renderSpecHtml());
    else if (kind === 'fhir') openJson('{ } PQI FHIR Bundle — Bundle-drug-product-specification-pq', APIX.pqi.bundle || APIX.pqi.normalize());
    else if (kind === 'validate') {
      var rows = APIX.pqi.validate().map(function (v) {
        return '<tr><td>' + esc(v.test) + '</td><td>' + esc(v.criterion) + '</td><td>' + esc(v.measured) +
          '</td><td class="pass">✓ PASS</td></tr>';
      }).join('');
      openModal('<h2 class="modal-title">✓ Structured validation — batch vs. acceptance criteria</h2>' +
        '<p class="muted">Read directly from the PQI ObservationDefinitions — no transcription from a PDF.</p>' +
        '<table class="val-table"><thead><tr><th>Test</th><th>Criterion</th><th>Measured</th><th>Result</th></tr></thead><tbody>' + rows + '</tbody></table>');
    }
  }
  function openPeek(ref) {
    if (ref === 'Task') openJson('{ } Task — Type IB variation', store.task);
    else if (ref === 'notif') openJson('{ } Subscription notification Bundle', lastNotif);
    else { var r = store.get(ref); if (r) openJson('{ } ' + r.resourceType + (r.content ? ' — ' + r.content[0].attachment.title : ''), r); }
  }

  /* ---- store events ----------------------------------------------------- */
  store.bus.addEventListener('task', function (ev) {
    if (ev.detail.firstTime) {
      convLine('out', '🏭 SynthPharma', '🏛️ Health Authority',
        'Submitted Type IB variation (Task created)', 'Task');
    } else if (!el('reg').hidden) {
      updateRegStatus(ev.detail.task);
    }
  });
  store.bus.addEventListener('notification', function (ev) {
    lastNotif = ev.detail.bundle;
    var msg = bizPlain(ev.detail.businessStatus);
    flyChip('🔔 ' + APIX.display('businessStatus', ev.detail.businessStatus), 'left');
    convLine('in', '🏛️ Health Authority', '🏭 SynthPharma', '🔔 ' + esc(msg), 'notif');
    setTimeout(function () { renderTracker(ev.detail.businessStatus, ev.detail.businessStatus); }, 520);
  });

  /* ---- client I/O feed (request/response inspector) --------------------- */
  APIX.client.bus.addEventListener('io', function (ev) { addIo(ev.detail); });

  /* ---- reset ------------------------------------------------------------ */
  function resetAll() {
    i = 0; reviewDone = {}; reached = {}; lastNotif = null; apixDrawn = false;
    ioEntries = [];
    store.reset();
    ['b-sources', 'a-normalize', 'b-spec', 'a-render', 'b-formats', 'pkg', 'tracker', 'reg', 'review', 'reg-flex', 'loopnote', 'conversation'].forEach(function (id) { el(id).hidden = true; });
    ['sources', 'harmonize', 'consolidated', 'pkg', 'reg-docs', 'reg-outputs', 'reg-status', 'review', 'apixsteps', 'lane', 'conv-log', 'io-list'].forEach(function (id) { el(id).innerHTML = ''; });
    setIoCount(); setDrawer(false);
    el('inbox-empty').hidden = false;
    el('conn').className = 'conn'; el('conn').innerHTML = '<span class="dot"></span> Not connected';
    el('view-exchange').hidden = true; el('view-author').hidden = false;
    refreshControls();
  }

  /* ---- wiring ----------------------------------------------------------- */
  document.addEventListener('click', function (ev) {
    var sum = ev.target.closest('.io-sum');
    if (sum) { var det = sum.parentNode.querySelector('.io-detail'); if (det) det.hidden = !det.hidden; return; }
    var m = ev.target.closest('[data-mode]'); if (m) { renderConsolidated(m.getAttribute('data-mode')); return; }
    var d = ev.target.closest('[data-doc]'); if (d) { openDoc(d.getAttribute('data-doc')); return; }
    var p = ev.target.closest('[data-peek]'); if (p) { openPeek(p.getAttribute('data-peek')); return; }
  });
  el('io-toggle').addEventListener('click', function () { setDrawer(!ioOpen); });
  el('io-close').addEventListener('click', function () { setDrawer(false); });
  el('stepbtn').addEventListener('click', runStep);
  el('resetbtn').addEventListener('click', resetAll);
  el('modal-close').addEventListener('click', function () { el('modal').hidden = true; });
  el('modal').addEventListener('click', function (ev) { if (ev.target === el('modal')) el('modal').hidden = true; });

  setStepper(1);
  refreshControls();
})();
