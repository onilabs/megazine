require("apollo:jquery-binding").install();
var logging = require("apollo:logging");

var http = require('apollo:http');
var yql = require("apollo:yql");
var s = require("apollo:common").supplant;
var cutil = require('apollo:cutil');
var dom = require('apollo:dom');
var date = new Date();
var dow = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
var c = require('apollo:collection');
var imgServiceDomains = ["twitpic.com", "yfrog.com"];

if(logging.isEnabled(logging.VERBOSE)) {
  require("apollo:debug").console({receivelog:false});
}

var logging = require("apollo:logging");
var collection = require("apollo:collection");

// the main app controller
var App = exports.App = function App() {
  window.app = this;
  this.loading = true;
  this.status = {
    loading:true,
    connected: false,
  };
  this.reset();

  // Load the @Anywhere API and init with your application id:
  this.twitter = require("apollo:twitter").initAnywhere({id:"hkEsBjNpWsOVKQ2gKyr1kQ"});
  spawn(this.run());
};

App.prototype.run = function() {
  // show twitter connect button:
  this.twitter("#login").connectButton();
  while(true) {
    this.status.connected = this.twitter.isConnected();
    this.status.loading = false;
    this.$eval();
    // wait until we're connected:
    if (!this.status.connected) this.twitter.waitforEvent("authComplete");
    this.status.connected = true;
    this.status.loading = true;
    this.$eval();
    waitfor {
      this.load_tweets();
      hold();
    } or {
      var e = $("#signout").$click();
      collapse;
      e.returnValue = false;
      e.preventDefault();
      logging.info("sign out button clicked!");
      twttr.anywhere.signOut();
      this.reset();
      this.status.connected = false;
    }
  }
};

App.prototype.reset = function() {
  this.cols = [[],[],[]];
  this.tweets = [];
  this.linklessTweets = [];
  this.articles = {};
  this.title="The news";
  this.about=null;
  this.status.unprocessedTweets = 0;
  this.runner = null;
};

App.prototype.load_tweets = function() {
  this.title = "The "+(date.getHours()||12)+" O'Clock News";
  var user = this.twitter.call("users/show", {user_id: this.twitter.currentUser.id});
  this.about = "The twitter links of " + user.name + " on " + dow[date.getDay()];

  waitfor (var tweets) { this.twitter.User.current().homeTimeline(resume); }
  this.tweets = tweets.array;

  logging.verbose("all tweets: ", null, this.tweets);

  this.status.unprocessedTweets += this.tweets.length;
  c.par.each(this.tweets, this.processTweet, this);
};

App.prototype.processTweet = function(tweet) {
  (function() {
    logging.debug("processing tweet: ",null, tweet);
    var link = /(https?:\/\/[^ ]+)/g;
    var links = tweet.text.match(link);
    tweet.name = tweet.user.name;

    if(!(links && links.length)) {
      this.linklessTweets.push(tweet);
      return;
    }

    var url = links[0];

    // expand URL if needed
    url = getExpandedURL(url);
    
    if (!this.articles[url]) {
      // create and load in two steps, since the load step is blocking
      // and we want to make sure this.articles[url] is set immediately
      var article = this.articles[url] = new Article(url, tweet, this);
      article.loadContent();
      this.showArticle(article);
    } else {
      // article already exists; just add this tweet to its references
      this.articles[url].addTweet(tweet);
    }
  }).call(this);
  this.status.unprocessedTweets--;
  this.status.loading = false;
  this.$root.$eval();
};

App.prototype.showArticle = function(article) {
  //TODO: this is a bit hacky - inspecting the HTML output to see where articles
  // should be distributed
  logging.info("Showing article: " + article, null, article);
  var columns = $('.col');
  var columnHeights = columns.map(function() { return $(this).height() }).get();
  var minColumnHeight = Math.min.apply(Math, columnHeights);
  var minColumnIndex = columnHeights.indexOf(minColumnHeight);
  this.cols[minColumnIndex].push(article);
  this.$root.$eval();
};

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

// -------------------- models --------------------

var Article = exports.Article = function(url, tweet) {
  this.url = url;
  this.tweets = [tweet];
};

Article.prototype.addTweet = function(tweet) {
  this.tweets.push(tweet);
};

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
    this.heading.image = img.src;
    this.contextImage = null;
    this.tweet = this.tweetText();
  } else {
    this.contextImage = this.img;
    var titleAndTweet = this.getTitleAndTweet();
    this.heading.text = titleAndTweet[0];
    this.tweet = titleAndTweet[1];
  }
  this.summary = this.getSummary();
  this.tweet = this.tweetText();
};
Article.prototype.toString = function() {
  return s("<Article from: {url}>", this);
};
Article.prototype.tweetText = function() { return this.tweets[0].text; }

Article.prototype.getTitleAndTweet = function() {
  var title = this.contents.title;
  var tweet = this.tweetText();
  if(!title) {
    // use tweet as title, but don't show anything for tweet text
    title = tweet;
    tweet = null;
  }
  return [title, tweet];
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

