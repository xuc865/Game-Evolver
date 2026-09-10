/*
 * Bounded static sanity check for polybranch.pjs (no browser needed).
 *
 * The browser loads polybranch.pjs through the vendored processing-1.4.1
 * preprocessor. This script runs that exact preprocessor in Node and then
 * parses the transformed JS. It catches Java-style syntax regressions in
 * seconds, which is enough to tell "the code is broken" from "the machine
 * is too loaded to run headless Chrome" before spending minutes on the
 * boot probe.
 *
 * Usage: node game/tests/transpile-check.js
 * Exit 0 = sketch source transpiles and parses, 1 = failure.
 */
var path = require('path');
var fs = require('fs');

// Minimal DOM stubs so the vendored processing lib can load in Node.
var el = function () {
  return { style: {}, setAttribute: function () {}, appendChild: function () {}, addEventListener: function () {}, getContext: function () { return null; } };
};
global.window = global;
global.navigator = global.navigator || { userAgent: 'node' };
global.document = global.document || {
  getElementsByTagName: function () { return [{}]; },
  getElementById: function () { return null; },
  createElement: el,
  createTextNode: function () { return {}; },
  addEventListener: function () {},
  removeEventListener: function () {},
  documentElement: el(),
  head: el(),
  body: el()
};

var LIB = path.join(__dirname, '..', 'js', 'libs', 'processing-1.4.1.min.js');
var SRC = path.join(__dirname, '..', 'polybranch.pjs');

require(LIB);
if (typeof global.Processing !== 'function' || typeof global.Processing.compile !== 'function') {
  console.log('TRANSPILE CHECK FAIL: vendored processing lib did not expose Processing.compile');
  process.exit(1);
}

var source = fs.readFileSync(SRC, 'utf8');
var sketch;
try {
  sketch = global.Processing.compile(source);
} catch (e) {
  console.log('TRANSPILE CHECK FAIL: Processing.compile threw: ' + (e && e.message || e));
  process.exit(1);
}
var code = sketch && sketch.sourceCode;
if (typeof code !== 'string' || code.length < 100) {
  console.log('TRANSPILE CHECK FAIL: preprocessor produced no transformed source');
  process.exit(1);
}
try {
  new Function(code);
} catch (e) {
  console.log('TRANSPILE CHECK FAIL: transformed JS does not parse: ' + (e && e.message || e));
  process.exit(1);
}
console.log('TRANSPILE CHECK OK: polybranch.pjs transpiles (' + source.length + ' chars -> ' + code.length + ' chars JS) and parses');
