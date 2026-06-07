/*
 * js/sign.js — APIX.sign: cryptographic tamper-evidence for the structured spec.
 *
 * Mirrors the SETU sealing approach: RFC 8785 (JCS) canonicalization of the FHIR
 * Bundle, then a detached JWS signature with alg PS256 — i.e. RSA-PSS over
 * SHA-256 (the WebCrypto algorithm), salt length 32. The detached signature is
 * carried as a FHIR `Signature` on a `Provenance` (Provenance.signature).
 *
 *   Applicant (SynthPharma) signs with the demo PRIVATE key at submit.
 *   Regulator (FDA) verifies with the demo PUBLIC key.
 *
 * The keys below are ILLUSTRATIVE DEMO KEYS — generated for this demo, embedded
 * in the page, NOT a real credential. They exist only to make the sign → verify
 * → tamper → re-verify beat run offline and on any backend.
 *
 * Environment-agnostic: uses the global WebCrypto (crypto.subtle), TextEncoder
 * and btoa/atob — present in browsers and in Node ≥ 20, so the same code runs in
 * the page and in validation/dump.js.
 */
(function () {
  // —— ILLUSTRATIVE DEMO KEYPAIR (RSA-PSS 2048 / SHA-256). NOT A REAL CREDENTIAL. ——
  var PUBLIC_JWK = {"alg":"PS256","kty":"RSA","n":"vNDolDcx0ReiX84EM2gsLd-qym-zZ3DiADAEMtWKzAx3zqH0GOuSmrrYMBeV-d7BQGpMP6r5hDAG7brBgT86FepgiU30ezTISZdx7BTONigcuecROgzMuzLeJyky7fnULsS28hgT8XQsdeZvIx_ETI90ojsjj7-3zt6nuHPW_hkhOTZLo5ZgOQZjW_IGzNO_pJvRqdkiZZ9shMgC916xri0y6S3sV2U_sqgOQ8HIeA7MrYYE5cIfjMB-D7v2I8M741DMtDyX4UAvFfpI71-riT9m-AwOzgc6QeWEB0J5YjPbxwwvKvnUNWyEgfWTxrQE6BmbmEYa0DQ3aJ7wnTnBfQ","e":"AQAB"};
  var PRIVATE_JWK = {"alg":"PS256","kty":"RSA","n":"vNDolDcx0ReiX84EM2gsLd-qym-zZ3DiADAEMtWKzAx3zqH0GOuSmrrYMBeV-d7BQGpMP6r5hDAG7brBgT86FepgiU30ezTISZdx7BTONigcuecROgzMuzLeJyky7fnULsS28hgT8XQsdeZvIx_ETI90ojsjj7-3zt6nuHPW_hkhOTZLo5ZgOQZjW_IGzNO_pJvRqdkiZZ9shMgC916xri0y6S3sV2U_sqgOQ8HIeA7MrYYE5cIfjMB-D7v2I8M741DMtDyX4UAvFfpI71-riT9m-AwOzgc6QeWEB0J5YjPbxwwvKvnUNWyEgfWTxrQE6BmbmEYa0DQ3aJ7wnTnBfQ","e":"AQAB","d":"F1wRKiUZ-LBf2lJ2mpWMwbAmRR1EqMuCaluGaXOZ1FzGhb3roRmj7ZioHmsMlvlEF2APRuE0NXJrqQWt4vubiBKTFumaEZQaI2ClK3v3dyPHSgiYTQJAYfiNG3MxZde-tHqJ17G65ehlh8CWh1Xqxz4IQ_nlEGe7qdBKF7vdIVpr4e5z-EiEXYmkHiM_2eyzHWPiTFgcKG__Z0knDTrorhfQ24jZja0etD_YxrSNFUOqVct87F3-FfWHYf6Z0x0jrHusoRWlfZSVoUK6Tb-4PUc1wSNdQJ9JiSs58QWD9cNDKTS5lhxtb4FlhATC3XoIMvokL2qttLtVHflGME96UQ","p":"8uvKc2XZEUQgLNHePDsfJ4PIJz-PLPe-KUm14Xuy7WKCirQ7y0O5rTItLzyxLkm4Mq0SumlPrvxc2CXFr-QUm1Y44VQyYaBIAEIqATfCd1ySMK9bYHDZzbjJsXboo1p9JfyUNhcWGhf7Vm5YSn-c_pQc496lwWINwEl1M1OHnU8","q":"xvthzq7CFk_EsU4bbrcympaQvTnXhQJl4J3xOGS_6eZcxCN2lA1FYzlr754ytWdGEc9Dl4fZCkQ-2pgPaa77EuxXKHpdG0BFwMQkR7PC5zq2dk31kA24iG6wX6Co_fZPPs5jLCM75S8Is6btxXs4sUy25ymvmHhY7MmV-BdguXM","dp":"7HAsAN3kxTV1y6oJkL5KuH8_1VO725zW7gDckrd_lCYJwU9j05f7pWPtLsj3-4GtU0W5sM7HzB29kHRTUbvBguANRORalUMYUYgUslK_aMYlVFWZruioVd_CEIUYMcblgI-zAmK-FG-7JokITpqfB_rJk9ElrG_vynS1Klvm52k","dq":"pBGnJhqm4mrHjkMPD41y5lB76-sDsCK4CitxOMSqEZzmpLtxDMacjiJMw3k36qfK-OhjnVBgP7zh7rAvFT84uvOxMikjGFM4sKeKGq04ahzZUlcZwbvuimBqgY8hiLZNxUW8NCqhOmo7zJY5u_nMVzUgIx8WMKwa9rOJOtVb5c0","qi":"SkrvmHTH-Fsk-G6Wz_TseNvOztYnpR7CLqYpJtLUSoTCZZjvOnfSuP4LbKYy_ayHjYf6ZbID5pugsd1wwGtgVDtP2q9x3obut_EqXlms81__5FHjqLFXQS4Najin6-3YUhgnQvnXwVLcmMTE2ca_3LqzQEasC_-YYcbUnH6yrnE"};

  var SIGN_ALG = { name: 'RSA-PSS', saltLength: 32 };
  var IMPORT_ALG = { name: 'RSA-PSS', hash: 'SHA-256' };
  var _priv = null, _pub = null;
  function subtle() { return (typeof crypto !== 'undefined' && crypto.subtle) ? crypto.subtle : null; }
  function privKey() { return _priv || (_priv = subtle().importKey('jwk', PRIVATE_JWK, IMPORT_ALG, false, ['sign'])); }
  function pubKey() { return _pub || (_pub = subtle().importKey('jwk', PUBLIC_JWK, IMPORT_ALG, false, ['verify'])); }

  /* ---- encoding helpers (browser + Node ≥ 20) ---- */
  function u8(s) { return new TextEncoder().encode(s); }
  function deU8(b) { return new TextDecoder().decode(b); }
  function bytesToB64(bytes) {
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function b64ToBytes(b64) {
    var bin = atob(b64), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function b64url(bytes) { return bytesToB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  function b64urlToBytes(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return b64ToBytes(s); }

  /* ---- RFC 8785 (JCS) canonicalization, JSON profile FHIR uses ----
     Object keys sorted by UTF-16 code unit; arrays preserve order; primitives
     serialized per ECMAScript (= JSON.stringify). No insignificant whitespace. */
  function canonicalize(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(canonicalize).join(',') + ']';
    var keys = Object.keys(v).sort();
    return '{' + keys.map(function (k) { return JSON.stringify(k) + ':' + canonicalize(v[k]); }).join(',') + '}';
  }

  /* Build a FHIR R5 Signature for the detached JWS. Signature.type uses the
     ISO-ASTM E1762 signature-type system; "Author's Signature" for the sponsor. */
  function buildSignature(dataB64) {
    var orgId = (window.APIX && APIX.seed && APIX.seed.applicant) ? APIX.seed.applicant.id : 'org-synthpharma-ag';
    return {
      type: [{ system: 'urn:iso-astm:E1762-95:2013', code: '1.2.840.10065.1.12.1.1', display: "Author's Signature" }],
      when: new Date().toISOString(),
      who: { reference: 'Organization/' + orgId, display: 'SynthPharma AG' },
      targetFormat: 'application/fhir+json',
      sigFormat: 'application/jose',
      data: dataB64
    };
  }

  /* Sign a FHIR resource (the spec Bundle): JCS → detached JWS (PS256). */
  async function signBundle(bundle) {
    var header = { alg: 'PS256', typ: 'JOSE' };
    var hB = b64url(u8(JSON.stringify(header)));
    var pB = b64url(u8(canonicalize(bundle)));
    var signingInput = hB + '.' + pB;
    var sig = await subtle().sign(SIGN_ALG, await privKey(), u8(signingInput));
    var detached = hB + '..' + b64url(new Uint8Array(sig));   // detached: payload omitted
    return buildSignature(bytesToB64(u8(detached)));
  }

  /* Verify a FHIR Signature against a (possibly altered) Bundle. Recomputes the
     JCS payload from the supplied Bundle, so any single-field change fails. */
  async function verify(bundle, signature) {
    try {
      if (!signature || !signature.data) return false;
      var jws = deU8(b64ToBytes(signature.data)).split('.');   // [hB, '', sB]
      if (jws.length !== 3) return false;
      var signingInput = jws[0] + '.' + b64url(u8(canonicalize(bundle)));
      return await subtle().verify(SIGN_ALG, await pubKey(), b64urlToBytes(jws[2]), u8(signingInput));
    } catch (e) { return false; }
  }

  /* Produce a tampered copy of the Bundle: alter the one signed field that
     matters — the end-of-shelf-life Water Content limit (1.5 → 2.5 % w/w). */
  function tamper(bundle) {
    var clone = JSON.parse(JSON.stringify(bundle));
    var hit = null;
    (function walk(o) {
      if (!o || typeof o !== 'object') return;
      if (!Array.isArray(o) && o.range && o.range.high && o.range.high.value === 1.5 && !hit) hit = o.range.high;
      Object.keys(o).forEach(function (k) { walk(o[k]); });
    })(clone);
    var info = null;
    if (hit) { info = { field: 'Water Content (end of shelf life) limit', from: hit.value + ' % w/w', to: '2.5 % w/w' }; hit.value = 2.5; }
    return { bundle: clone, info: info };
  }

  window.APIX = window.APIX || {};
  APIX.sign = {
    demo: true,                       // illustrative keys — clearly labelled
    canonicalize: canonicalize,
    signBundle: signBundle,
    verify: verify,
    tamper: tamper,
    publicJwk: PUBLIC_JWK
  };
})();
