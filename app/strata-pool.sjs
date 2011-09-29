var cutil = require("apollo:cutil");
var c = require("apollo:collection");

var StrataPool = exports.StrataPool = function StrataPool() {
  this.error = new cutil.Event();
  this.change = new cutil.Event();
  this.empty = new cutil.Event();
  this.reset();
};

StrataPool.prototype = {
  abort: function(error) {
    if(this._aborting) return; // prevent reentrant abort() calls from retract / error handlers
    this._aborting = true;
    c.each(this.strata, function(strata) { strata.abort(); });
    this.strata = [];
    if(error) {
      this.error.set(error);
    }
    this._aborting = false;
    this._changed();
  },

  reset: function() {
    if(this.strata && this.strata.length > 0) {
      this.abort();
    }
    this.change.clear();
    this.empty.clear();
    this._aborting = false;
    this.strata = [];
    this.error.clear();
    this.size = 0;
  },

  run: function(fn, _this) {
    var strata = this.add(fn,_this);
    return strata.waitforValue();
  },

  add: function(fn, _this, cb) {
    var strata;
    var task = function() {
      hold(0); // ensure strata makes it into `this.strata` and gets returned immediately
      var err = undefined;
      var result;
      try {
        result = fn.call(_this);
      } catch(e) {
        err = e;
      }
      c.remove(this.strata, strata);
      if(err !== undefined) {
        this.abort(err);
        return;
      }
      this._changed();
      if(cb) { cb.call(_this, result); }
    };
    strata = spawn(task.call(this));
    this.strata.push(strata);
    this._changed();
    return strata;
  },

  _changed: function() {
    var self = this;
    this.size = this.strata.length;
    this.change.set();
    this.change.clear();
    if(this.size == 0) {
      this.empty.set();
    } else {
      this.empty.clear();
    }
  }
};

