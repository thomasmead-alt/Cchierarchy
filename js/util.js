// Shared utilities used across modules. Loaded first so every other JS file
// can call norm / escape / escapeAttr / cssEscape without redefining its own.
//
// Important: this file declares globals (no module system). Subsequent files
// (csv.js, diff.js, recommend.js, etc.) historically each had their own
// `var norm = ...`. With classic <script> loading the last-declared wins,
// which was a latent source of subtle bugs. Define exactly once here.

function norm(s) { return s == null ? '' : String(s).trim(); }

function escape(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function escapeAttr(s) { return escape(s).replace(/`/g, '&#96;'); }

function cssEscape(s) {
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s);
  return String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c);
}
