var logging = require("sjs:logging");
var seq = require("sjs:sequence");

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
    logging.debug("cache #{obj ? 'HIT' : 'MISS'}: #{key} [#{this.service}]");
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
      logging.warn("non-string key in DB: ", key);
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
    try {
      this.db.each(function(item) {
        var key = item.key;
        var seen = key in self._seen && self._seen.hasOwnProperty(key);
        if(!seen) {
          del_keys.push(item.key);
        }
      });
    }
    catch(e) {
      // XXX There is some bug in lawnchair which sometimes gets the
      // db into a bad state (keys there, but entries missing). This
      // causes db.each() to throw. Best we can do for now is to remove
      // the whole db:
      logging.debug("lawnchair db is corrupt; deleting");
      // XXX this.db.nuke() won't work; we'll assume DOM storage for now:
      if (!window.localStorage) return;
      try {
        JSON.parse(window.localStorage[this.service+'._index_']).forEach(function(i) {
          delete window.localStorage[i];
        });
      }
      catch (e) {
        logging.debug("lawnchair db index is corrupt too.");
      }
      delete window.localStorage[this.service+'._index_'];
      return;
    }
    logging.debug("removing #{del_keys.length} keys from #{this.service}:", del_keys);
    del_keys .. seq.each.par(this.remove.bind(this));
    waitfor(var items) { this.db.get(del_keys, resume); }
    if(items.length > 0) {
      logging.error("#{items.length} cache items did not get deleted from collection #{this.service}:", items);
    }
  }
};

