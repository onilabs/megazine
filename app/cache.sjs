var logging = require("apollo:logging");
var common = require("apollo:common");

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
    this._keep(obj.key);
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
    this._keep(obj.key);
    return obj;
  },

  _keep: function(key) {
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
    logging.debug("removing {len} keys from {service}", {len: del_keys.length, service: this.service});
    this.db.remove(del_keys);
  }
};

