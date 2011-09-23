var logging = require("apollo:logging");
var common = require("apollo:common");
var collection = require("apollo:collection");

// increment VERSION when changing data model
var VERSION = 1;

var Cache = exports.Cache = function Cache(service) {
  this.service = service;
  this._seen = {};
  waitfor() {
    this.db = new Lawnchair({name: service}, resume);
  }
}

Cache.prototype = {
  save: function(obj) {
    this._keep(obj);
    waitfor() {
      obj._DB_VERSION = VERSION;
      this.db.save(obj, resume);
    }
  },

  get: function(key) {
    waitfor(var obj) {
      this.db.get(key, resume);
    }
    if (!obj || obj._DB_VERSION != VERSION) return null;
    this._keep(obj);
    return obj;
  },

  _keep: function(obj) {
    var key = obj.key;
    if(!key || (key.toString() !== key)) {
      throw new Error("item persisted to " + this.service + " cache without a string key: " + JSON.stringify(obj));
    }
    this._seen[key] = true;
  },

  flush: function() {
    // remove all keys from the DB that we haven't
    // seen so far in the current session
    var del_keys = [];
    var self = this;
    this.db.each(function(item) {
      var key = item.key;
      var seen = key in self._seen && self._seen.hasOwnProperty(key);
      if(!seen) {
        del_keys.push(item.key);
      }
    });
    logging.debug("removing {len} keys from {service}", {len: del_keys.length, service: this.service}, del_keys);
    waitfor() { this.db.remove(del_keys, resume); }
    waitfor(var items) { this.db.get(del_keys, resume); }
    if(items.length > 0) {
      logging.error("{length} cache items did not get deleted:" , items, items);
    }
  }
};

