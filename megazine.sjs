require("apollo:jquery-binding").install();
var logging = require("apollo:logging");

var http = require('apollo:http');
var yql = require("apollo:yql");
var common = require("apollo:common");
var s = common.supplant;
var cutil = require('apollo:cutil');
var dom = require('apollo:dom');
var dow = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
var c = require('apollo:collection');
var imgServiceDomains = ["twitpic.com", "yfrog.com"];
var underscore = require("./underscore.js");
var logging = require("apollo:logging");
var collection = require("apollo:collection");

// replace with your own application id:
var twitterAppId = "hkEsBjNpWsOVKQ2gKyr1kQ";

if(logging.isEnabled(logging.VERBOSE)) {
  require("apollo:debug").console({receivelog:false});
}

// the main app controller
var App = exports.App = function App(route) {
  route.when('/twitter', {controller: Twitter, template: "templates/twitter.html"});
  route.when('/hackernews', {controller: HackerNews, template: "templates/hackernews.html"});
  spawn(this.run(route));
};
App.$inject=['$route'];

App.prototype.run = function(route) {
  // every time the route changes, load the appropriate
  // news type (and abort the old news loader if required):
  var currentStrata;
  while (true) {
    waitfor() { route.onChange(resume); }
    if(currentStrata) { currentStrata.abort(); currentStrata = null; }
    hold(0); // scope seems to be initialized right *after* this code, so we need a delay

    if(!(route.current && route.current.scope)) continue;
    this.news = route.current.scope;
    this.news._init();
    currentStrata = spawn(this.news.run());
  };
};

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
            throw new Error("Couldn't load news items.");
          }
        }
        var newItems = this.addNewItems(items);
        c.par.map(newItems, function(item) {
          using(this.workItem()) {
            this.processItem(item);
          }
        }, this);

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
    this.twitter = require("apollo:twitter").initAnywhere({id:twitterAppId});
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
      this.redraw(true);
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

    // strage that twitter doesn't provide this...
    tweet.url = s("http://twitter.com/#!/{user}/status/{id}",
      {user:tweet.user.screenName, id:tweet.id});

    if(!(links && links.length)) {
      this.linklessTweets.push(tweet);
      return;
    }

    var url = links[0];

    // expand URL if needed
    url = getExpandedURL(url);
    
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



// -------------------- URL / Image helper functions --------------------



// attach a rate limited version of `fn` to `fn.rateLimited`
function rateLimit(fn, rate) {
  fn.rateLimited = cutil.makeRateLimitedFunction(fn, rate);
};

var getExpandedURL = (function() {
  var cache = {};
  return function(url) {
    if(!cache[url]) {
      cache[url] = expandUrl.rateLimited(url);
    }
    return cache[url];
  };
})();

var expandUrl = exports.expandUrl = function(url) {
  var data = http.jsonp("http://api.longurl.org/v2/expand", {
    query: {
      url: url,
      format: 'json',
      'user-agent': 'oni apollo: megazine'
    }
  });
  return data['long-url'];
}
rateLimit(expandUrl, 4);

var getURLContents = exports.getURLContents = function getURLContents(url) {
  var xpath = "//title[1]|//img[@src]|//meta[@name='description']|//script[contains(.,'hqdefault')]";
  var query = "select * from html where url=@url and xpath=@xpath";

  var result = (yql.query(query, {
    url:url,
    xpath:xpath
  }));

  logging.debug("querying article {url} with xpath {xpath} returns:", {
    url: url,
    xpath: xpath},
    result.results);

  return result.results;
};

rateLimit(getURLContents, 3);

function extractImage(page, url) {
  var images = page.img;
  //page is the object returned by getURLContents.
  if (page.script) {
    // looking for http://i.ytimg.com/vi/lOTtpRAs5FY/hqdefault.jpg
    var m = page.script.content.match(/(http.+?hqdefault.jpg)/);
    if (m && m.length) images = [{src: m[0], width:300}];
  }
  
  if (images && images.length) {
    return getBestImage(images, url);
  } else {
    return null;
  }
};

function getBestImage(images, baseURL) {
  c.each(images, guessImageSize);

  // filter out images < 140px; we never want to display them
  images = c.filter(images, function(img) { return (img.width === undefined) || (img.width > 140); });
  images.sort(imageCompare);

  if(images.length == 0) return null;
  logging.debug("images (worst to best) = ", null, images);

  var best_img = images[images.length-1];
  var fullURL = http.canonicalizeURL(best_img.src, baseURL);
  logging.debug("Canonicalizing URL " + best_img.src + " on " + baseURL + " -> " + fullURL);
  return new Image(fullURL, isImageService(baseURL));
};

function imageCompare(a, b) {
  var criteria = function(img) {
    var isJpeg = img.src.match(/\.jpe?g/);
    var width = img.width ? img.width : 0;
    // isJpeg trumps width, jpegs are less likely page decoration
    return [isJpeg ? 1 : 0, width];
  }

  var ca = criteria(a);
  var cb = criteria(b);
  if(ca[0]!=cb[0]) return ca[0] - cb[0];
  return ca[1] - cb[1];
};

function guessImageSize(img) {
  if(img.size) return;
  var match;

  // guess based on style attribute (accurate but uncommon)
  var styleRe = /(?:^|[^-])width: *(\d+)px/;
  match = (img.style && img.style.match(styleRe));
  if(match) {
    logging.debug("guessed image width of " + match[1] + " based on style string: " + img.style, null, match);
    img.width = parseInt(match[1]);
    return;
  };

  // guess based on URL params (inaccurate)
  var sizeRe = /(?:x|w|xsize|size|width)=(\d+)/;
  match = img.src.match(sizeRe);
  if(match) {
    logging.debug("guessed image width of " + match[1] + " based on url: " + img.src);
    img.width = parseInt(match[1]);
  }
};

function isImageService(url) {
  var domain = http.parseURL(url).authority;
  domain = domain.replace(/^wwww\./, ''); // strip leading www
  return imgServiceDomains.indexOf(domain) !== -1;
};

// -------------------- Article / Image objects --------------------

var Article = exports.Article = function(url, user, text, pointerURL) {
  this.url = url;
  this.users = [user];
  this.pointerText = text;
  this.pointerURL = pointerURL;
};

Article.prototype.addUser = function(user) {
  this.users.push(user);
};

Article.prototype.userList = function() { return this.users.join(", "); };

Article.prototype.loadContent = function() {
  logging.debug("Processing article: {url}", this);
  this.heading = {};

  var contents = getURLContents.rateLimited(this.url);

  if (!contents) {
    logging.debug("no contents found for article:" + this);
    this.heading.text = this.url;
    return;
  }
  
  this.contents = contents;
  this.img = extractImage(this.contents, this.url);

  if(this.img && this.img.imgService) {
    this.heading.image = this.img.src;
    this.contextImage = null;
  } else {
    this.contextImage = this.img;
    this.populateTitle();
  }
  this.summary = this.getSummary();
};

Article.prototype.toString = function() {
  return s("<Article from: {url}>", this);
};

Article.prototype.populateTitle = function() {
  // set header.text to contents.title.
  // if the title is undefined, shift this.pointerText to replace it
  this.heading.text = this.contents.title;
  if(!this.heading.text) {
    // use tweet as title, but don't show anything for tweet text
    this.heading.text = this.pointerText;
    this.pointerText = null;
  }
};

Article.prototype.getSummary = function() {
  if(!(this.contents.meta && this.contents.meta.content)) return;
  var summary = {
    text: this.contents.meta.content,
    style: {}
  };

  if (summary.text.length > 300) {
    summary.style['text-align'] = "justify";
  }
  return summary;
};


function Image(src, imgService) {
  this.src = src;
  this.imgService = imgService;
  this.style = {
    'background-image': s('url({src})', this),
  };
  if(imgService) {
    this.style.height = 200;
  }
};
Image.prototype.toString = function() { return s("<Image: {src}>", this); };

