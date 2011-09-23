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

var dow = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

var newsFunctions = {
  // methods common across all news sources (twitter, hackernews, ...)
  reset: function() {
    this.articles = {};
    this.title = 'The news';
    this.about=null;
    this.unprocessedItems = 0;
    this.items = [];
    this.redraw();
    this.title = this.getTitle();
  },
  
  loadTimeout: 5000,

  _init: function() {
    this.reset();
    this.cache = new Cache(this.type);
    this.appendMethod = 'push'; // start by putting new items at the bottom
    this.errorEvent = new cutil.Event();
  },

  processItems: function(items) {
    // process each item, wrapped in a `work item` to show
    // the number of pending items in the UI
    c.par.map(items, function(item) {
      using(this.workItem()) {
        this.processItem(item);
        this.items.push(item);
      }
    }, this);
    this.flush_cache();
  },

  flush_cache: function() {
    this.cache.flush();
  },

  rerun: function() {
    this.error = null;
    spawn(this.run());
  },

  run: function() {
    this.errorEvent.clear();
    try {
      // keep loading new items every 2 mins
      while(true) {
        this.title = this.getTitle();
        using(this.workItem()) {
          try {
            var items = this.loadNewItems();
          } or {
            hold(this.loadTimeout);
            throw new Error(this.type + " items not received within " + Math.round(this.loadTimeout / 1000) + " seconds");
          }
        }
        var newItems = this.filterNewItems(items);
        this.processItems(newItems);
        this.appendMethod = 'unshift'; // future items get inserted above existing items
        hold(1000 * 60 * 2);
      }
    } or {
      this.errorEvent.wait();
    } catch(e) {
      this.setError(e);
    }
  },

  setError: function(e) {
    if(!(e instanceof Error)) { e = new Error(e); }
    logging.error("Error loading news: {message}", e, e);
    this.error = e;
    this.errorEvent.set();
    this.redraw();
    throw(e);
  },

  getTitle: function() {
    var date = new Date();
    return "The "+(date.getHours()||12)+" O'Clock News";
  },

  workItem: function() {
    // context manager to keep track of the number of currently-executing blocking tasks
    var self = this;
    self.unprocessedItems++;
    return {
      __finally__: function() {
        self.unprocessedItems--;
        self.redraw();
      }
    };
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

  processArticle: function(id, url, user, text, pointerURL) {
    if (!this.articles[url]) {
      // create and load in two steps, since the load step is blocking
      // and we want to make sure this.articles[url] is set immediately
      var article = this.articles[url] = new Article(id, url, user, text, pointerURL);
      logging.debug("getting article", null, article);
      var cached = this.cache.get(id);
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
      this.articles[url].addUser(user);
    }
  },

  redraw: function() {
    if(!this.$root) {
      // XXX why does this happen?
      logging.warn("redraw() called while $root is undefined", null, this);
      return;
    }
    this.$root.$eval();
    hold(0);
  },

  showArticle: function(article) {
    if(article.hidden) return;
    logging.info("Showing article: " + article, null, article);
    // get the column with the smallest displyed height
    var columns = $('.col', this.$element);
    var columnHeights = columns.map(function() { return $(this).height() }).get();
    var minColumnHeight = Math.min.apply(Math, columnHeights);
    var minColumnIndex = columnHeights.indexOf(minColumnHeight);
    this.columns[minColumnIndex][this.appendMethod](article);
  },

  hideArticle: function(article, column) {
    logging.debug("hiding article: ", null, article);
    this.bg(function() {
      article.hidden = true;
      try {
        this.cache.save(article);
      } and {
        angular.Array.remove(column, article);
      }
    });
  },

  bg: function(action) {
    spawn((function() {
      try {
        action.call(this);
      } catch (e) {
        this.setError(e);
      }
      this.redraw();
    }).call(this));
  }
};

var Twitter = exports.Twitter = function Twitter() {};
Twitter.prototype = common.mergeSettings(newsFunctions, {
  super: newsFunctions,
  type:'twitter',

  _init: function() {
    logging.info("twitter initializing");
    this.loading = true;
    this.twitter = require("apollo:twitter").initAnywhere({id:this.appId});
    this.twitter("#login").connectButton();
    this.loading = false;
    this.url_cache = new Cache("twitter_urls");
    this.super._init.call(this);
  },
  reset: function() {
    this.columns = [[],[],[]];
    this.signoutEvent = new cutil.Event();
    this.linklessTweets = [];
    this.connected = false;
    this.super.reset.call(this);
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
    // overrise super.run() to ensure we're connected first
    while(true) {
      this.awaitAuth();
      this.redraw();
      waitfor {
        this.super.run.call(this);
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
    
    this.processArticle(tweet.id, url, tweet.user.name, tweet.text, tweet.url);
  },

  flush_cache: function() {
    this.super.flush_cache.call(this);
    this.url_cache.flush();
  }
});

var HackerNews = exports.HackerNews = function HackerNews() {}
HackerNews.prototype = common.mergeSettings(newsFunctions, {
  super: newsFunctions,
  type: 'hackernews',

  reset: function() {
    this.columns = [[],[],[],[]];
    this.super.reset.call(this);
  },

  loadNewItems: function() {
    var date = new Date();
    this.about = "Hacker news links on " + dow[date.getDay()];
    return http.jsonp('http://api.ihackernews.com/page', {query: {format:'jsonp'}}).items;
  },

  processItem: function(item) {
    logging.debug("processing item: ",null, item);
    var commentUrl = s("http://news.ycombinator.com/item?id={id}", item);
    this.processArticle(item.id, item.url, item.postedBy, item.title, commentUrl);
  },

});

var RSS = exports.RSS = function RSS(route) {
  var url = this.url = decodeURIComponent(route.current.params.feed);
  this.type = 'rss:' + url;
};
RSS.$inject = ['$route'];
var yql = require('apollo:yql');

RSS.prototype = common.mergeSettings(newsFunctions, {
  super: newsFunctions,
  reset: function() {
    this.columns = [[],[],[],[]];
    this.super.reset.call(this);
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
    this.processArticle(item.id, item.link.href, null, null, null);
  }
});
