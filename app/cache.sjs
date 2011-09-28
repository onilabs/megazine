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
    logging.debug("cache {status}: {key} [{name}]", {
      status: obj ? 'HIT' : 'MISS',
      key: key,
      name: this.service
    });
    if (!obj || obj._DB_VERSION != VERSION) return null;
    this._keep(obj);
    return obj;
  },

  all: function() {
    waitfor(var all) {
      this.db.all(resume);
    }
    return all;
  },

  _keep: function(obj) {
    var key = obj.key;
    if(!key) {
      throw new Error("item persisted to " + this.service + " cache without a key: " + JSON.stringify(obj));
    }
    if(key.toString() !== key) {
      logging.warn("non-string key in DB: " + JSON.stringify(key));
      obj.key = key.toString();
    }
    this._seen[key] = true;
  },

  remove: function(key) {
    waitfor() { this.db.remove(key, resume); }
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
    collection.par.each(del_keys, this.remove, this);
    waitfor(var items) { this.db.get(del_keys, resume); }
    if(items.length > 0) {
      logging.error("{length} cache items did not get deleted from collection {service}:" , {
        length: items.length,
        service: this.service}, items);
    }
  }
};

