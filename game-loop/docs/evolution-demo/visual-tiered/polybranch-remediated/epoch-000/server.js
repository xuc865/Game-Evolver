#!/usr/bin/env node
/*
 * Minimal static file server for the PolyBranch game directory.
 * Usage: node game/server.js [port]  (defaults to 8000, binds 127.0.0.1)
 * No dependencies. Used by humans and by game/tests/smoke.js.
 */
var http = require('http');
var fs = require('fs');
var path = require('path');

var PORT = parseInt(process.argv[2], 10) || 8000;
var ROOT = __dirname;

var MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.pjs': 'text/plain; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.json': 'application/json'
};

function sendError(res, code, msg) {
  res.writeHead(code, { 'Content-Type': 'text/plain' });
  res.end(msg);
}

var server = http.createServer(function (req, res) {
  var urlPath;
  try {
    urlPath = decodeURIComponent(req.url.split('?')[0]);
  } catch (e) {
    return sendError(res, 400, 'bad request');
  }
  if (urlPath === '/') {
    urlPath = '/index.html';
  }
  var filePath = path.normalize(path.join(ROOT, urlPath));
  if (filePath.indexOf(ROOT) !== 0) {
    return sendError(res, 403, 'forbidden');
  }
  fs.stat(filePath, function (err, stat) {
    if (!err && stat.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      stat = null;
      try { stat = fs.statSync(filePath); } catch (e2) { err = e2; }
    }
    if (err || !stat || !stat.isFile()) {
      return sendError(res, 404, 'not found: ' + urlPath);
    }
    var ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-store'
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, '127.0.0.1', function () {
  console.log('PolyBranch serving ' + ROOT + ' at http://127.0.0.1:' + PORT + '/');
});

process.on('SIGTERM', function () { server.close(function () { process.exit(0); }); });
process.on('SIGINT', function () { server.close(function () { process.exit(0); }); });
