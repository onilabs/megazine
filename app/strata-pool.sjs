var cutil = require("sjs:cutil");
var array = require('sjs:array');
var seq = require('sjs:sequence');
var logging = require("sjs:logging");

var StrataPool = exports.StrataPool = function StrataPool() {
  this.error = new cutil.Condition();
  this.change = new cutil.Event();
  this.empty = new cutil.Condition();
  this.reset();
};

StrataPool.prototype = {
  abort: function(error) {
    if(this._aborting) return; // prevent reentrant abort() calls from retract / error handlers
    this._aborting = true;
    this.strata .. seq.filter(x -> x) .. seq.each {|stratum| stratum.abort(); };
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
    this.empty.clear();
    this.error.clear();
    this._aborting = false;
    this.strata = [];
    this.size = 0;
  },

  run: function(fn, _this) {
    var stratum = this.add(fn,_this);
    return stratum.waitforValue();
  },

  add: function(fn, _this, cb) {
    var stratum;
    var task = function() {
      hold(0); // ensure stratum makes it into `this.strata` and gets returned immediately
      var err = undefined;
      var result;
      try {
        result = fn.call(_this);
        if(cb) { cb.call(_this, result); }
      } catch(e) {
        err = e;
      } finally {
        this.strata .. array.remove(stratum);
        this._changed();
        if(err !== undefined) {
          this.abort(err);
          throw err;
        }
      }
      hold(0); 
    };
    stratum = spawn(task.call(this));
    this.strata.push(stratum);
    this._changed();
    return stratum;
  },

  _changed: function() {
    logging.debug("strata pool changed, now has #{this.strata.length} strata");
    var self = this;
    this.size = this.strata.length;
    if(this.size == 0) {
      this.empty.set();
    } else {
      this.empty.clear();
    }
    this.change.emit();
  }
};

