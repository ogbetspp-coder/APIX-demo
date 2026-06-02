/*
 * PQI (Pharmaceutical Quality, HL7 uv-dx-pq) module — Act 1 of the demo.
 *
 * Models the REAL uv-dx-pq drug-product specification structure:
 *   Bundle -> PlanDefinition (actions grouped by "Release" vs "End of shelf life")
 *          -> each test is an ObservationDefinition (code + method + qualifiedValue)
 *
 * Story: spec data is scattered across mocked source systems; we normalise it to
 * the PQI schema, then render it BOTH as a human eCTD 3.2.P.5.1 PDF and as the
 * structured FHIR Bundle. The variation being submitted = tightening the
 * end-of-shelf-life Water Content limit (2.0% -> 1.5% w/w).
 *
 * NOTE: criteria are adapted from the published uv-dx-pq example
 * (bundle-drug-product-specification-pq-ex1) for an illustrative, legible demo.
 */
window.APIX = window.APIX || {};

APIX.pqi = (function () {
  var PQ = 'http://hl7.org/fhir/uv/pharm-quality';
  var LOCAL_CS = PQ + '/CodeSystem/cs-local-codes-drug-pq-example';
  var TEXT_EXT = PQ + '/StructureDefinition/Extension-qualified-value-text-pq';
  var BUNDLE_PROFILE = PQ + '/StructureDefinition/Bundle-drug-product-specification-pq';

  /* The regulatory change carried by this variation. */
  var CHANGE = {
    test: 'WaterContent',
    label: 'End-of-shelf-life Water Content limit',
    before: 'NMT 2.0% w/w',
    after: 'NMT 1.5% w/w',
    rationale: 'Tightened in line with updated 36-month stability data (Type IB, B.II.d.1).'
  };

  /* ---- Mocked source systems (heterogeneous, "messy") ------------------- */
  var sources = [
    {
      system: 'LIMS — QC Specification export',
      tag: 'CSV',
      note: 'Release limits, lab shorthand',
      rows: [
        'DESCR | visual        | orange FC tab, deb. "175"',
        'IDT   | UHPLC         | RT + UV vs ref. std',
        'ASSAY | UHPLC         | 95-105 %LC',
        'DISSO | App2/UV       | Q=80% @ 30 min',
        'WATER | KF, USP<921>  | NMT 1.0% (release)',
        'DEGPR | UHPLC         | tot NMT 1.4% (release)'
      ]
    },
    {
      system: 'Stability System — shelf-life limits',
      tag: 'XML',
      note: 'End-of-shelf-life, 36-month data',
      rows: [
        'WATER  shelf-life : NMT 1.5%   ← updated',
        'DEGPR  shelf-life : tot NMT 2.3%',
        'ASSAY  shelf-life : as release',
        'DISSO  shelf-life : as release'
      ]
    },
    {
      system: 'Analytical Method Repository',
      tag: 'REST',
      note: 'Validated method descriptions',
      rows: [
        'M-001  Assay by UHPLC',
        'M-014  Apparatus 2 (paddles), UV measurement',
        'M-022  Degradation products by UHPLC',
        'USP <921> (water) · Ph Eur (micro)'
      ]
    }
  ];

  /* ---- Canonical spec model (the normalised "truth") -------------------- */
  /* Each test: code/display/method + release + shelfLife acceptance criteria.
     criteria are either { text } or { ranges: [{ appliesTo, high, unit }] }.   */
  var tests = [
    { code: 'DESC', display: 'Description', method: 'Visual inspection',
      release: { text: 'An orange film-coated tablet, debossed with 175 on one side' },
      shelfLife: { text: 'As for release' } },
    { code: 'IDT', display: 'Identification', method: 'ID by UHPLC',
      release: { text: 'Consistent with the retention time and UV spectrum of the reference standard' },
      shelfLife: { text: 'As for release' } },
    { code: 'ASSAY', display: 'Assay', method: 'Assay by UHPLC',
      release: { text: '95% to 105% of label claim' },
      shelfLife: { text: 'As for release' } },
    { code: 'Dissolution', display: 'Dissolution', method: 'Apparatus 2 (paddles), UV measurement',
      release: { text: 'Q = 80% at 30 minutes (harmonised USP / JP / Ph Eur)' },
      shelfLife: { text: 'As for release' } },
    { code: 'DGP', display: 'Degradation Products', method: 'Degradation products by UHPLC', impurity: true,
      release: { ranges: [
        { appliesTo: 'Impurity 1', high: 0.2 }, { appliesTo: 'Impurity 2', high: 0.3 },
        { appliesTo: 'Impurity 3', high: 0.3 }, { appliesTo: 'Individual unspecified', high: 0.2 },
        { appliesTo: 'Total degradation products', high: 1.4 } ] },
      shelfLife: { ranges: [
        { appliesTo: 'Impurity 1', high: 0.8 }, { appliesTo: 'Impurity 2', high: 0.4 },
        { appliesTo: 'Impurity 3', high: 0.4 }, { appliesTo: 'Individual unspecified', high: 0.5 },
        { appliesTo: 'Total degradation products', high: 2.3 } ] } },
    { code: 'WaterContent', display: 'Water Content', method: 'USP <921>',
      release: { ranges: [{ high: 1.0 }] },
      shelfLife: { ranges: [{ high: 1.5 }] },               // <-- the variation (was 2.0)
      changed: true, beforeShelfLife: 'NMT 2.0% w/w' },
    { code: 'Microbiological Quality', display: 'Microbiological Quality', method: 'Ph Eur',
      release: { text: 'Shall comply with the requirements of the Ph Eur' },
      shelfLife: { text: 'Shall comply with the requirements of the Ph Eur' } }
  ];

  /* Render an acceptance criterion (release or shelfLife) as readable text. */
  function criterionText(c) {
    if (!c) return '—';
    if (c.text) return c.text;
    if (c.ranges) {
      return c.ranges.map(function (r) {
        return (r.appliesTo ? r.appliesTo + ': ' : '') + 'NMT ' + r.high.toFixed(1) + '% w/w';
      }).join('; ');
    }
    return '—';
  }

  /* Build a single ObservationDefinition for a test at a given timing. */
  function buildOD(test, timing) {
    var c = timing === 'release' ? test.release : test.shelfLife;
    var od = {
      resourceType: 'ObservationDefinition',
      id: 'od-' + test.code.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + timing,
      url: 'urn:uuid:od-' + test.code.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + timing,
      title: test.display,
      status: 'active',
      code: { coding: [{ system: LOCAL_CS, code: test.code, display: test.display }], text: test.display }
    };
    if (timing === 'release' || !test.shelfLife.text || test.shelfLife.text !== 'As for release' || test.changed) {
      od.method = { text: test.method };
    }
    if (c.text) {
      od.qualifiedValue = [{ extension: [{ url: TEXT_EXT, valueString: c.text }] }];
    } else if (c.ranges) {
      od.qualifiedValue = c.ranges.map(function (r) {
        var qv = { range: { high: { value: r.high, unit: '% w/w' } } };
        if (r.appliesTo) qv.appliesTo = [{ text: r.appliesTo }];
        return qv;
      });
      if (test.impurity) od.component = [{ code: { coding: [{ system: LOCAL_CS, code: 'IMP', display: 'Impurity' }] } }];
    }
    return od;
  }

  /* Normalise the source data into the PQI Bundle. Returns + caches it. */
  function normalize() {
    var entries = [];
    var releaseActions = [];
    var shelfActions = [];

    tests.forEach(function (t) {
      var rel = buildOD(t, 'release');
      var shelf = buildOD(t, 'shelfLife');
      entries.push({ fullUrl: rel.url, resource: rel });
      entries.push({ fullUrl: shelf.url, resource: shelf });
      releaseActions.push({ code: { text: 'Test' }, definitionCanonical: rel.url });
      shelfActions.push({ code: { text: 'Test' }, definitionCanonical: shelf.url });
    });

    var plan = {
      resourceType: 'PlanDefinition',
      id: 'plandefinition-drug-product-specification',
      url: 'urn:uuid:plandefinition-drug-product-specification',
      title: 'SPECIFICATION(S) FOR DRUG PRODUCT',
      status: 'active',
      subjectReference: { reference: 'MedicinalProductDefinition/' + APIX.seed.product.id, display: APIX.seed.product.name[0].productName },
      description: 'Finished-product release and shelf-life specification, normalised to PQI.',
      action: [{
        title: 'Specification(s) for Drug Product',
        code: { text: 'Overall set of actions' },
        action: [
          { title: 'Release', code: { text: 'Timing Group' }, timingTiming: { code: { text: 'Release time' } }, action: releaseActions },
          { title: 'End of shelf life', code: { text: 'Timing Group' }, timingTiming: { code: { text: 'At end of shelf life' } }, action: shelfActions }
        ]
      }]
    };

    APIX.pqi.bundle = {
      resourceType: 'Bundle',
      id: 'bundle-drug-product-specification',
      meta: { profile: [BUNDLE_PROFILE] },
      type: 'collection',
      entry: [{ fullUrl: plan.url, resource: plan }].concat(entries)
    };
    return APIX.pqi.bundle;
  }

  /* Flat rows for the on-screen spec table. */
  function specRows() {
    return tests.map(function (t) {
      return {
        test: t.display,
        method: t.method,
        release: criterionText(t.release),
        shelfLife: criterionText(t.shelfLife),
        changed: !!t.changed,
        before: t.beforeShelfLife || null
      };
    });
  }

  /* Render the human-readable eCTD 3.2.P.5.1 "PDF" view (HTML). */
  function renderSpecHtml() {
    var rows = specRows().map(function (r) {
      var shelf = r.changed
        ? '<span class="diff-old">' + r.before + '</span> <span class="diff-new">' + r.shelfLife + ' w/w</span>'
        : r.shelfLife;
      return '<tr' + (r.changed ? ' class="row-changed"' : '') + '>' +
        '<td>' + r.test + '</td><td>' + r.method + '</td>' +
        '<td>' + r.release + '</td><td>' + shelf + '</td></tr>';
    }).join('');
    return '' +
      '<div class="ectd-doc">' +
        '<div class="ectd-head"><span>MODULE 3.2.P.5.1</span><span>SPECIFICATION — DRUG PRODUCT</span></div>' +
        '<h2>' + APIX.seed.product.name[0].productName + '</h2>' +
        '<p class="ectd-meta">Marketing Authorisation Holder: SynthPharma AG &nbsp;·&nbsp; MPID: ' +
          APIX.seed.product.identifier[0].value + ' &nbsp;·&nbsp; Variation: Type IB (B.II.d.1)</p>' +
        '<table class="ectd-table"><thead><tr><th>Test</th><th>Analytical Method</th>' +
          '<th>Acceptance Criteria (Release)</th><th>Acceptance Criteria (Shelf Life)</th></tr></thead>' +
          '<tbody>' + rows + '</tbody></table>' +
        '<p class="ectd-foot">Change in this submission: ' + CHANGE.label + ' — ' +
          CHANGE.before + ' → <strong>' + CHANGE.after + '</strong>. ' + CHANGE.rationale + '</p>' +
      '</div>';
  }

  /* Regulator-side: machine-check a tested batch against the structured criteria. */
  function validate() {
    var batch = { ASSAY: 99.2, Dissolution: 88, WaterContent: 0.6, DGP_total: 0.6 };
    return [
      { test: 'Assay', criterion: '95–105% LC', measured: '99.2%', pass: true },
      { test: 'Dissolution', criterion: 'Q ≥ 80% / 30 min', measured: '88%', pass: true },
      { test: 'Water Content (release)', criterion: '≤ 1.0% w/w', measured: '0.6%', pass: true },
      { test: 'Total Degradation Products', criterion: '≤ 1.4% w/w', measured: '0.6%', pass: true }
    ];
  }

  return {
    sources: sources, tests: tests, CHANGE: CHANGE, bundle: null,
    normalize: normalize, specRows: specRows, criterionText: criterionText,
    renderSpecHtml: renderSpecHtml, validate: validate
  };
})();
