#!/usr/bin/env apollo

var http = require('apollo:http');
var cutil = require('apollo:cutil');

exports.topHNStories = null;
var getTopHNStories = cutil.makeBoundedFunction(
  function() {
    if (exports.topHNStories == null) {
      update();
      spawn updateLoop();
    }
    return exports.topHNStories;
  },
  1);


function update() {
  console.log("contacting hn...");
  waitfor {
    var payload = http.get('http://api.ihackernews.com/page', {query: {format: 'json'}});
  }
  or {
    hold(5*60*1000);
    console.log("timeout");
    return;
  }
  console.log("done");
  exports.topHNStories = payload;
}

function updateLoop() {
  while (true) {
    hold(5*60*1000);
    try {
      update();
    } catch(updateErr) {
      process.stderr.write("Error updating: " + updateErr + "\n (will try again in 5 minutes)\n");
    }
  }
}

function jsonp(cb, content) {
  return cb + "(" + content + ");";
}

function requestHandler(req, res) {
  try {
    req.parsedURL = http.parseURL("http://"+req.headers.host+req.url);
    if (req.method !== "GET") throw "Unknown method";
    var cb = req.parsedURL.queryKey.callback;
    if(req.parsedURL.queryKey.format != 'jsonp') throw "only `jsonp` format is supported"
    if(!cb) throw "No `callback` name provided"
    var content = getTopHNStories();

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.writeHead(200, {"Content-Type":"application/json; charset=utf-8"});
    res.end(jsonp(cb, content));
  }
  catch (e) {
    try {
      res.writeHead(400);
      res.end(e.toString());
    } catch (writeErr) {
      process.stderr.write(writeErr + "\n (original error: " + e + "\n");
    }
  }
}

var port = '7865';
process.stdout.write("listening on port " + port + "\n");
require('apollo:node-http').runSimpleServer(requestHandler, port);
