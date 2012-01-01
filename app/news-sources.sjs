var logging = require("apollo:logging");
var c = require('apollo:collection');
var cutil = require("apollo:cutil");
var common = require("apollo:common");
var s = common.supplant;
var http = require("apollo:http");

var Article = require('article').Article;

var underscore = require("../lib/underscore.js");
var Content = require("./content-extraction");
var Cache = require("./cache").Cache;
var StrataPool = require('./strata-pool').StrataPool;

var dow = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

var newsFunctions = {
  // methods common across all news sources (twitter, hackernews, ...)
  reset: function() {
    this.pool.reset();
    var self = this;
    this.articles = {};
    this.title = 'The news';
    this.about=null;
    this.unprocessedItems = 0;
    this.items = [];
    this.redraw();
    this.title = this.getTitle();
  },
  
  loadTimeout: 7000,

  _init: function() {
    this.pool = new StrataPool();
    this.cache = new Cache(this.type);
    this.appendMethod = 'push'; // start by putting new items at the bottom
    this.reset();
  },

  processItems: function(items) {
    // process each item, wrapped in the strata pool to show
    // the number of pending items in the UI
    c.par.map(items, function(item) {
      this.pool.run(function() {
        this.processItem(item);
        this.items.push(item);
      }, this);
    }, this);
    this.flush_cache();
  },

  flush_cache: function() {
    this.cache.flush();
  },

  rerun: function() {
    spawn(this.run());
  },

  run: function() {
    this.pool.reset();
    try {
      // keep loading new items every 2 mins
      while(true) {
        this.title = this.getTitle();
        var newItems;
        this.pool.run(function() {
          var items = this.loadNewItems();
          newItems = this.filterNewItems(items);
        }, this);
        this.processItems(newItems);
        this.appendMethod = 'unshift'; // future items get inserted above existing items
        hold(1000 * 60 * 2);
      }
    } or {
      this.pool.error.wait();
    } or {
      while (true) {
        this.pool.change.wait();
        this.redraw();
      }
    } catch(e) {
      this.pool.abort(e);
    } finally {
      this.redraw();
    }
  },

  getTitle: function() {
    var date = new Date();
    return "The "+(date.getHours()||12)+" O'Clock News";
  },

  filterNewItems: function(newItems, idProp){
    // returns only the items that haven't already been seen
    idProp = idProp || 'id';
    var existingItems = this.items;
    var existingIds = underscore.pluck(existingItems, idProp);
    var newIds = [];
    c.each(newItems, function(item) {
      var id = item[idProp];
      if(!id) {
        logging.warn("encountered item without ID - ignoring", null, item);
      } else {
        newIds.push(id);
      }
    });

    newIds = underscore.difference(newIds, existingIds);
    newItems = underscore.select(newItems, function(t) { return underscore.include(newIds, t[idProp]); });
    return newItems;
  },

  processArticle: function(opts) {
    var url = opts.url;
    if(!url) throw new Error("no URL given in article");

    if (!this.articles[url]) {
      // create and load in two steps, since the load step is blocking
      // and we want to make sure this.articles[url] is set immediately
      var article = this.articles[url] = new Article(opts);
      logging.debug("getting article", null, article);
      var cached = this.cache.get(article.key);
      if(cached) {
        logging.verbose("using cached article for URL " + url);
        underscore.extend(article, cached);
      } else {
        article.loadContent();
        this.cache.save(article);
      }
      this.showArticle(article);
    } else {
      // article already exists; just add this user to its references
      this.articles[url].update(opts);
    }
  },

  redraw: function() {
    if(!this.$root) {
      // XXX why does this happen?
      logging.warn("redraw() called while $root is undefined", null, this);
      return;
    }
    this.$root.$eval();
  },

  getColumns: function() {
    // XXX We need to check if the template for our view has been
    // loaded. This is very hackish; Angular discourages accessing
    // views from controllers.
    var columns;
    while (!(columns = $('.col', this.$element)).length) {
      waitfor () {
        this.$onEval(resume);
      }
    }
    return columns;
  },

  showArticle: function(article) {
    if(article.hidden) return;
    logging.info("Showing article: " + article, null, article);
    // get the column with the smallest displayed height
    var columns = this.getColumns();
    var columnHeights = columns.map(function() { return $(this).height() }).get();
    var minColumnHeight = Math.min.apply(Math, columnHeights);
    var minColumnIndex = columnHeights.indexOf(minColumnHeight);
    this.columns[minColumnIndex][this.appendMethod](article);
    // We need to redraw here, so that our height measurements are up to date:
    this.redraw();
  },

  hideArticle: function(article, column) {
    logging.debug("hiding article: ", null, article);
    this.pool.add(function() {
      article.hidden = true;
      try {
        this.cache.save(article);
      } and {
        angular.Array.remove(column, article);
      }
    }, this);
  }

};

var Twitter = exports.Twitter = function Twitter() {};
Twitter.anywhere = null;
Twitter.prototype = common.mergeSettings(newsFunctions, {
  _super: newsFunctions,
  type:'twitter',

  _init: function() {
    logging.info("twitter initializing");
    this._super._init.call(this);
    this.pool.run(function() {
      if(!Twitter.anywhere) {
        Twitter.anywhere = require("apollo:twitter").initAnywhere({id:this.appId});
      }
      this.twitter = Twitter.anywhere;
      this.twitter("#login").connectButton();
    }, this);
    this.url_cache = new Cache("twitter_urls");
  },
  reset: function() {
    this.columns = [[],[],[]];
    this.signoutEvent = new cutil.Condition();
    this.linklessTweets = [];
    this.connected = false;
    this._super.reset.call(this);
  },

  loadNewItems: function() {
    var date = new Date();
    var user = this.twitter.call("users/show", {user_id: this.twitter.currentUser.id});
    this.about = "The twitter links of " + user.name + " on " + dow[date.getDay()];

    waitfor (var tweets) { this.twitter.User.current().homeTimeline(resume); }
    return tweets.array;
  },

  awaitAuth: function() {
    this.connected = this.twitter.isConnected();
    this.redraw();
    // wait until we're connected:
    if (!this.connected) this.twitter.waitforEvent("authComplete");
    this.connected = true;
  },

  run: function() {
    // override _super.run() to ensure we're connected first
    while(true) {
      this.awaitAuth();
      this.redraw();
      waitfor {
        this._super.run.call(this);
      } or {
        this.signoutEvent.wait();
        collapse;
        twttr.anywhere.signOut();
        this.reset();
      }
    }
  },

  triggerSignout: function() {
    this.signoutEvent.set();
  },

  processItem: function(tweet) {
    logging.debug("processing tweet: ",null, tweet);
    var link = /(https?:\/\/[^ ]+)/g;
    var links = tweet.text.match(link);
    tweet.name = tweet.user.name;

    // strange that twitter doesn't provide this...
    tweet.url = s("http://twitter.com/#!/{user}/status/{id}",
      {user:tweet.user.screenName, id:tweet.idStr});
    
    if(!(links && links.length)) {
      this.linklessTweets[this.appendMethod](tweet);
      return;
    }

    var url = links[0];

    // expand URL if needed
    url = Content.getExpandedURL(url, this.url_cache);
    
    this.processArticle({
      id: tweet.id,
      url: url,
      user: tweet.user.name,
      text: tweet.text,
      pointerURL: tweet.url
    });
  },

  flush_cache: function() {
    this._super.flush_cache.call(this);
    this.url_cache.flush();
  }
});

var HackerNews = exports.HackerNews = function HackerNews() {}
HackerNews.prototype = common.mergeSettings(newsFunctions, {
  _super: newsFunctions,
  type: 'hackernews',

  reset: function() {
    this.columns = [[],[],[],[]];
    this._super.reset.call(this);
  },

  loadTimeout: 10 * 1000,

  _fetchFrontPage: function() {
    // attempt to fetch the front page news from multiple sources, since ihackernews is
    // frequently down:
    var sources = [
      {url: 'http://www.onilabs.com:7865/', delay: 0},
      {url: 'http://api.ihackernews.com/page', delay: this.loadTimeout / 2},
    ];

    var pending = sources.length;
    var load = function(source) {
      try {
        hold(source.delay);
        return http.jsonp(source.url, {query: {format:'jsonp'}}).items;
      } catch(e) {
        pending -= 1;
        if(pending > 0) {
          // allow other stratum to succeed
          hold();
        } else {
          // everything else already failed!
          throw e;
        }
      }
    };
    while (1) {
      try {
        waitfor {
          return c.par.waitforFirst(load, sources, this);
        }
        or {
          hold(1000*60*2);
          logging.warn("News requests timing out ");
        }
      }
      catch (e) {
        logging.warn("Error retrieving news: "+e);
        // just retry in a bit; maybe should have backoff algo here
        hold(1000*60);
      }
    }
  },

  loadNewItems: function() {
    var date = new Date();
    this.about = "Hacker news links on " + dow[date.getDay()];
    return this._fetchFrontPage();
  },

  processItem: function(item) {
    logging.debug("processing item: ",null, item);
    var hn_base = 'http://news.ycombinator.com';
    var commentUrl = s(hn_base + "/item?id={id}", item);
    this.processArticle({
      id: item.id,
      url: http.canonicalizeURL(item.url, hn_base),
      user: item.postedBy,
      text: item.title,
      pointerURL: commentUrl
    });
  },

});

var RSS = exports.RSS = function RSS(route) {
  var url = this.url = decodeURIComponent(route.current.params.feed);
  this.type = 'rss:' + url;
};
RSS.$inject = ['$route'];
var yql = require('apollo:yql');

RSS.prototype = common.mergeSettings(newsFunctions, {
  _super: newsFunctions,
  reset: function() {
    this.columns = [[],[],[],[]];
    this._super.reset.call(this);
  },
  loadNewItems: function() {
    var rv = yql.query("select * from feednormalizer where url = @url and output='atom_1.0'", {
      url: this.url
    });
    logging.info("RSS feed entries: ",null, rv);
    this.about = "Latest articles from \"" + rv.results.feed.title + "\" on " + dow[new Date().getDay()];
    var entries = rv.results.feed.entry;
    if(!entries) throw new Error("No entries found for feed " + this.url);
    return entries;
  },

  processItem: function(item) {
    logging.debug("processing feed entry: ", null, item);
    var content = null;
    if(item.summary && item.summary.content) content = item.summary.content;
    if(item.content && item.content.content) content = item.content.content;
    this.processArticle({
      id: item.id,
      url: item.link.href,
      title: item.title,
      content: content
    });
  }
});
