/*
 * Tiny dependency-free JSON pretty-printer + syntax highlighter.
 * Returns an HTML string with tokens wrapped in <span class="tok-*"> elements.
 * No CDN, no npm — works from file://.
 */
window.APIX = window.APIX || {};

APIX.highlight = function (value) {
  var json = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  // Escape HTML first so resource content can never break the page.
  json = json
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  return json.replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
    function (match) {
      var cls = 'tok-num';
      if (/^"/.test(match)) {
        cls = /:$/.test(match) ? 'tok-key' : 'tok-str';
      } else if (/true|false/.test(match)) {
        cls = 'tok-bool';
      } else if (/null/.test(match)) {
        cls = 'tok-null';
      }
      return '<span class="' + cls + '">' + match + '</span>';
    }
  );
};
