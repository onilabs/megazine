var logging = require("apollo:logging");
var c = require('apollo:collection');
var cutil = require("apollo:cutil");
var common = require("apollo:common");
var s = common.supplant;
var http = require("apollo:http");

var Article = require('article').Article;

var underscore = require("../lib/underscore.js");
var Content = require("./content-extraction");

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

  _init: function() { this.reset(); },

  processItems: function(items) {
    // process each item, wrapped in a `work item` to show
    // the number of pending items in the UI
    c.par.map(items, function(item) {
      using(this.workItem()) {
        this.processItem(item);
      }
    }, this);
  },

  rerun: function() {
    this.error = null;
    spawn(this.run());
  },

  run: function() {
    try {
      // keep loading new items every 2 mins
      while(true) {
        this.title = this.getTitle();
        using(this.workItem()) {
          try {
            var items = this.loadNewItems();
          } or {
            hold(this.loadTimeout);
            throw new Error("Couldn't load news items in " + this.loadTimeout + "ms");
          }
        }
        var newItems = this.addNewItems(items);
        this.processItems(newItems);
        hold(1000 * 60 * 2);
      }
    } catch(e) {
      this.error = e;
      this.redraw();
      throw(e);
    }
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

  addNewItems: function(newItems, idProp){
    // adds all new items to this.items, and returns only
    // the items that haven't already been seen
    idProp = idProp || 'id';
    var existingItems = this.items;
    var existingIds = underscore.pluck(existingItems, idProp);
    var newIds = underscore.pluck(newItems, idProp);

    newIds = underscore.difference(newIds, existingIds);
    newItems = underscore.select(newItems, function(t) { return underscore.include(newIds, t.id); });
    this.items = existingItems.concat(newItems);
    return newItems;
  },

  processArticle: function(url, user, text, pointerURL) {
    if (!this.articles[url]) {
      // create and load in two steps, since the load step is blocking
      // and we want to make sure this.articles[url] is set immediately
      var article = this.articles[url] = new Article(url, user, text, pointerURL);
      article.loadContent();
      this.showArticle(article);
    } else {
      // article already exists; just add this user to its references
      this.articles[url].addUser(user);
    }
    this.redraw();
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
    logging.info("Showing article: " + article, null, article);
    // get the column with the smallest displyed height
    var columns = $('.col', this.$element);
    var columnHeights = columns.map(function() { return $(this).height() }).get();
    var minColumnHeight = Math.min.apply(Math, columnHeights);
    var minColumnIndex = columnHeights.indexOf(minColumnHeight);
    this.columns[minColumnIndex].push(article);
    this.redraw();
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
      {user:tweet.user.screenName, id:tweet.id});

    if(!(links && links.length)) {
      this.linklessTweets.push(tweet);
      return;
    }

    var url = links[0];

    // expand URL if needed
    url = Content.getExpandedURL(url);
    
    this.processArticle(url, tweet.user.name, tweet.text, tweet.url);
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
    this.processArticle(item.url, item.postedBy, item.title, commentUrl);
  },

});

