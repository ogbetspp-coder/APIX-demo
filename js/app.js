/*
 * UI controller for the APIX Live demo. Renders the three panels, drives the
 * presenter-paced scenario, and reacts to events from APIX.store (the "server").
 */
(function () {
  var store = APIX.store;
  var stepIndex = 0;
  var donePhases = {};

  /* ---- tiny DOM helpers ------------------------------------------------- */
  function el(id) { return document.getElementById(id); }
  function show(node) { if (node) node.hidden = false; }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function fmtBytes(n) { return n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.round(n / 1e3) + ' KB'; }

  /* ---- phase rail ------------------------------------------------------- */
  function renderRail() {
    var cur = APIX.scenario[stepIndex] ? APIX.scenario[stepIndex].phase : null;
    el('rail').innerHTML = APIX.acts.map(function (act) {
      var chips = act.steps.map(function (s) {
        var cls = 'chip';
        if (donePhases[s]) cls += ' done';
        if (s === cur) cls += ' active';
        return '<span class="' + cls + '">' + esc(s) + '</span>';
      }).join('<span class="sep">›</span>');
      return '<div class="act"><span class="act-label">' + esc(act.label) + '</span>' +
             '<div class="chips">' + chips + '</div></div>';
    }).join('');
  }

  /* ---- controls / step engine ------------------------------------------ */
  function refreshControls() {
    var step = APIX.scenario[stepIndex];
    if (step) {
      el('narration').textContent = step.narration;
      el('stepbtn').innerHTML = step.button + ' ▶';
      el('stepbtn').disabled = false;
      el('progress').textContent = 'Step ' + (stepIndex + 1) + ' / ' + APIX.scenario.length +
        '  ·  ' + (step.actor === 'regulator' ? 'Regulator' : 'Applicant');
    } else {
      el('narration').innerHTML = '✅ <strong>End to end in minutes.</strong> Every status change was timestamped — that audit trail is your cycle-time analytics. APIX carried both the PDF and the structured FHIR over the same rails.';
      el('stepbtn').innerHTML = 'Done';
      el('stepbtn').disabled = true;
      el('progress').textContent = 'Complete · ' + APIX.scenario.length + ' / ' + APIX.scenario.length;
    }
    renderRail();
  }

  function runStep() {
    var step = APIX.scenario[stepIndex];
    if (!step) return;
    var e = step.effect;
    switch (e.type) {
      case 'pull':      handlePull(); break;
      case 'normalize': handleNormalize(); break;
      case 'render':    show(el('card-formats')); break;
      case 'connect':   show(el('card-conn')); store.connect(); el('conn-status').className = 'status status-on'; el('conn-status').textContent = '🔒 Connected · Bearer token · Organization + Endpoint registered'; break;
      case 'submit':    handleSubmit(); break;
      case 'subscribe': handleSubscribe(); break;
      case 'updateTask':
        if (e.flexibility) show(el('reg-actions'));
        store.updateTask(e);
        break;
    }
    donePhases[step.phase] = true;
    stepIndex += 1;
    refreshControls();
  }

  /* ---- ACT 1 · PQI ------------------------------------------------------ */
  function handlePull() {
    show(el('card-sources'));
    el('sources').innerHTML = APIX.pqi.sources.map(function (s) {
      return '<div class="src"><div class="src-head"><span class="src-name">' + esc(s.system) +
        '</span><span class="tag">' + esc(s.tag) + '</span></div>' +
        '<div class="src-note">' + esc(s.note) + '</div>' +
        '<pre class="src-rows">' + esc(s.rows.join('\n')) + '</pre></div>';
    }).join('');
  }

  function handleNormalize() {
    APIX.pqi.normalize();
    show(el('card-spec'));
    var rows = APIX.pqi.specRows().map(function (r) {
      var shelf = r.changed
        ? '<span class="diff-old">' + esc(r.before) + '</span> → <span class="diff-new">' + esc(r.shelfLife) + ' w/w</span>'
        : esc(r.shelfLife);
      return '<tr' + (r.changed ? ' class="row-changed"' : '') + '><td>' + esc(r.test) + '</td>' +
        '<td class="dim">' + esc(r.method) + '</td><td>' + esc(r.release) + '</td><td>' + shelf + '</td></tr>';
    }).join('');
    el('spec').innerHTML =
      '<table class="spec-table"><thead><tr><th>Test</th><th>Method</th><th>Release</th><th>Shelf life</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table>' +
      '<p class="change-note">⚠ One change in this variation: <strong>' + esc(APIX.pqi.CHANGE.label) + '</strong> (' +
      esc(APIX.pqi.CHANGE.before) + ' → ' + esc(APIX.pqi.CHANGE.after) + ')</p>';
  }

  /* ---- ACT 2 · APIX ----------------------------------------------------- */
  function docIcon(contentType) { return contentType === 'application/fhir+json' ? '{ }' : '📄'; }

  function renderPayload(node) {
    if (!store.task) return;
    node.innerHTML = '<div class="payload-head">Task payload · ' + store.task.input.length + ' documents</div>' +
      store.task.input.map(function (inp) {
        var dref = store.get(inp.valueReference.reference);
        var ct = dref ? dref.content[0].attachment.contentType : 'application/pdf';
        var size = dref ? dref.content[0].attachment.size : 0;
        var spec = inp.type.coding[0].code === '3.2.P.5.1';
        return '<div class="doc' + (spec ? ' doc-spec' : '') + '"><span class="doc-ic">' + docIcon(ct) + '</span>' +
          '<span class="doc-ct">' + esc(inp.type.coding[0].code) + '</span>' +
          '<span class="doc-title">' + esc(inp.valueReference.display) + '</span>' +
          '<span class="doc-size">' + fmtBytes(size) + '</span></div>';
      }).join('');
  }

  function statusBadges(task) {
    return '<span class="badge badge-status">status: ' + esc(task.status) + '</span>' +
      '<span class="badge badge-biz">' + esc(task.businessStatus.coding[0].display) + '</span>' +
      (task.identifier.length > 1 ? '<span class="badge badge-proc">' + esc(task.identifier[1].value) + '</span>' : '');
  }

  function handleSubmit() {
    store.submit();
    renderPayload(el('payload'));
    var ta = el('task-applicant'); show(ta);
    ta.innerHTML = statusBadges(store.task);
  }

  function handleSubscribe() {
    store.subscribe();
    addNote('🔔 Subscribed to Task status changes — notifications will arrive automatically.');
    var t = el('timeline'); show(t);
    renderTimeline('submitted');
  }

  /* ---- timeline (FedEx-style) ------------------------------------------ */
  var reached = {};
  function renderTimeline(markCode) {
    if (markCode) reached[markCode] = new Date();
    el('timeline').innerHTML = '<div class="tl-title">Submission tracking</div><div class="tl-rail">' +
      APIX.businessStatusFlow.map(function (m) {
        var done = !!reached[m.code];
        var ts = done ? reached[m.code].toLocaleTimeString() : '';
        return '<div class="tl-node ' + (done ? 'done' : '') + '"><span class="tl-dot">' + (done ? m.icon : '○') +
          '</span><span class="tl-lbl">' + esc(m.label) + '</span><span class="tl-ts">' + ts + '</span></div>';
      }).join('') + '</div>';
  }

  function addNote(html) {
    var d = document.createElement('div');
    d.className = 'note';
    d.innerHTML = html;
    el('notes').appendChild(d);
  }

  /* ---- regulator console ------------------------------------------------ */
  function renderRegulator(task, firstTime) {
    if (firstTime) { el('reg-empty').hidden = true; show(el('card-regtask')); renderPayload(el('reg-docs')); }
    el('reg-badges').innerHTML = statusBadges(task);
    if (task.output && task.output.length) {
      el('reg-outputs').innerHTML = '<div class="payload-head">Outputs produced</div>' +
        task.output.map(function (o) {
          return '<div class="doc"><span class="doc-ic">📄</span><span class="doc-title">' + esc(o.valueReference.display) + '</span></div>';
        }).join('');
    }
  }

  /* ---- wire feed -------------------------------------------------------- */
  function appendWire(d) {
    var line = document.createElement('div');
    line.className = 'wire-line dir-' + d.dir;
    var arrow = d.dir === 'in' ? '◀' : (d.dir === 'reg' ? '▣' : (d.dir === 'sys' ? '◆' : '▶'));
    line.innerHTML = '<div class="wire-top"><span class="wseq">' + d.seq + '</span>' +
      '<span class="warr">' + arrow + '</span><span class="wmethod">' + esc(d.method) + '</span>' +
      '<span class="wurl">' + esc(d.url) + '</span><span class="wlabel">' + esc(d.label) + '</span></div>';
    if (d.resource) {
      var pre = document.createElement('pre');
      pre.className = 'wire-json';
      pre.hidden = true;
      pre.innerHTML = APIX.highlight(d.resource);
      line.appendChild(pre);
      line.querySelector('.wire-top').addEventListener('click', function () { pre.hidden = !pre.hidden; });
      line.querySelector('.wire-top').classList.add('clickable');
    }
    var feed = el('wirefeed');
    feed.appendChild(line);
    feed.scrollTop = feed.scrollHeight;
  }

  /* ---- modal ------------------------------------------------------------ */
  function openModal(html) { el('modal-body').innerHTML = html; el('modal').hidden = false; }
  function closeModal() { el('modal').hidden = true; }

  function openDoc(kind) {
    if (kind === 'pdf') {
      openModal('<h2 class="modal-title">📄 Rendered eCTD 3.2.P.5.1 (PDF view)</h2>' + APIX.pqi.renderSpecHtml());
    } else if (kind === 'fhir') {
      openModal('<h2 class="modal-title">{ } PQI FHIR Bundle — Bundle-drug-product-specification-pq</h2>' +
        '<pre class="modal-json">' + APIX.highlight(APIX.pqi.bundle || APIX.pqi.normalize()) + '</pre>');
    } else if (kind === 'validate') {
      var rows = APIX.pqi.validate().map(function (v) {
        return '<tr><td>' + esc(v.test) + '</td><td>' + esc(v.criterion) + '</td><td>' + esc(v.measured) +
          '</td><td class="' + (v.pass ? 'pass' : 'fail') + '">' + (v.pass ? '✓ PASS' : '✗ FAIL') + '</td></tr>';
      }).join('');
      openModal('<h2 class="modal-title">✓ Structured validation — batch vs acceptance criteria</h2>' +
        '<p class="muted">Read directly from the PQI ObservationDefinitions — no transcription from a PDF.</p>' +
        '<table class="val-table"><thead><tr><th>Test</th><th>Criterion</th><th>Measured</th><th>Result</th></tr></thead><tbody>' +
        rows + '</tbody></table>');
    }
  }

  /* ---- wiring ----------------------------------------------------------- */
  store.bus.addEventListener('wire', function (ev) { appendWire(ev.detail); });
  store.bus.addEventListener('task', function (ev) {
    renderRegulator(ev.detail.task, ev.detail.firstTime);
    if (el('task-applicant')) el('task-applicant').innerHTML = statusBadges(ev.detail.task);
  });
  store.bus.addEventListener('notification', function (ev) {
    renderTimeline(ev.detail.businessStatus);
    addNote('🔔 Real-time update: <strong>' + esc(APIX.display('businessStatus', ev.detail.businessStatus)) + '</strong>');
    el('card-conn').classList.add('flash');
    setTimeout(function () { el('card-conn').classList.remove('flash'); }, 600);
  });

  function resetAll() {
    stepIndex = 0; donePhases = {}; reached = {};
    store.reset();
    ['card-sources', 'card-spec', 'card-formats', 'card-conn'].forEach(function (id) { el(id).hidden = true; });
    el('sources').innerHTML = el('spec').innerHTML = el('payload').innerHTML = el('notes').innerHTML = '';
    el('wirefeed').innerHTML = el('reg-docs').innerHTML = el('reg-outputs').innerHTML = el('reg-badges').innerHTML = '';
    el('task-applicant').hidden = true; el('timeline').hidden = true; el('reg-actions').hidden = true;
    el('card-regtask').hidden = true; el('reg-empty').hidden = false;
    el('conn-status').className = 'status status-off'; el('conn-status').textContent = 'Not connected';
    refreshControls();
  }

  /* document-open buttons (applicant format chips + regulator actions) */
  document.addEventListener('click', function (ev) {
    var t = ev.target.closest('[data-doc]');
    if (t) openDoc(t.getAttribute('data-doc'));
  });
  el('stepbtn').addEventListener('click', runStep);
  el('resetbtn').addEventListener('click', resetAll);
  el('modal-close').addEventListener('click', closeModal);
  el('modal').addEventListener('click', function (ev) { if (ev.target === el('modal')) closeModal(); });

  refreshControls();
})();
