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

function processTweet(tweet) {
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
    this.articles[url] = {tweets: []};
  }

  this.articles[url].tweets.push(tweet);
};

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

function processArticle(article, url) {
  logging.debug("Processing article: {url}", {url:url});

  var contents = getURLContents.rateLimited(url);
  if (!contents) {
    logging.debug("no contents found for url {url}", {url:url});
    return null;
  }
  
  var result = new Article(url, contents, article.tweets);
  logging.info("processed article: ",null, result);
  return result;
};

function insertArticle(article) {
  logging.debug("inserting article: {title}",article,article);
  var cols = $("#timeline div.col");
  var col;

  $.each(cols, function (i, c) {
    if (!col || $(c).height() < col.height()) {
      col = $(c);
    }
  });

  $(col).append(article.toHtml());
};

exports.run = function() {
  $("h1").html("The "+(date.getHours()||12)+" O'Clock News");

  var user = T.call("users/show", {user_id: T.currentUser.id});

  $("#about").html("The twitter links of " + user.name + " on " + dow[date.getDay()]);

  waitfor (var tweets) { T.User.current().homeTimeline(resume); }


  logging.verbose("all tweets: ", null, tweets);

  var context = {
    articles: {},
    linklessTweets: []
  };

  c.par.each(tweets.array, processTweet, context);

  $(".tweets").html("<h3>Linkless updates</h3>");
  c.each(context.linklessTweets, function(tweet) {
    $(".tweets").append(s("<div class='btweet'>{text}<div class='user'>by {name}</div></div>", tweet));
  });

  var pageCheck = {};

  context.articles = c.par.map(context.articles, processArticle);
  exports.articles = context.articles; //DEBUG
  // failed summaries return null, so strip them:
  context.articles = c.filter(context.articles, c.identity);

  c.each(context.articles, insertArticle);
};


// -------------------- models --------------------
function Image(src, imgService) {
  this.src = src;
  this.imgService = imgService;
  this.height = imgService ? 200 : null;
};
Image.prototype.toString = function() { return s("<Image: {src}>", this); };
Image.prototype.toHtml = function() {
  var style="background-image:url({src});";
  if(this.height) {
    style += "height:{height};";
  };
  return s("<div style='" + style + "' class='illustration'></div>", this);
};



function Article(url, contents, tweets) {
  this.contents = contents;
  this.url = url;
  this.hasTitle = !!this.contents.title;
  this.img = extractImage(this.contents, this.url);
  this.tweets = tweets;
  if(this.img && this.img.imgService) {
    this.heading = this.imageHeading();
    this.contextImage = "";
  } else {
    this.heading = this.textHeading();
    this.contextImage = this.imgHtml();
  }
}
Article.prototype.toString = function() {
  return s("<Article from: {url}>", this);
};
Article.prototype.toHtml = function() {
  var parts = [
    this.heading,
    this.source(),
    this.contextImage,
    this.hasTitle ? this.tweet() : null,
    this.summary()
  ];

  return "<div class='article'><div class='inner'>" + parts.join("\n") + "</div></div>";
};

Article.prototype.imageHeading = function() {
  return s("<a href='{url}'><img src='{imgUrl}' class='heading'/></a>", {url: this.url, imgUrl:this.img.src});
};

Article.prototype.textHeading = function() {
  return s("<h3><a href='{url}'>{title}</a></h3>", this);
};

Article.prototype.imgHtml = function() {
  if(!this.img) return;
  return this.img.toHtml();
};

Article.prototype.title = function() {
  if(this.hasTitle) {
    return this.contents.title;
  }
  return this.tweetText();
};

Article.prototype.summary = function() {
  if(!(this.contents.meta && this.contents.meta.content)) return "";
  var summaryText = this.contents.meta.content;
  var summaryStyle = '';
  if (summaryText > 300) {
    summaryStyle = "text-align:justify";
  }
  return "<div class='summary' style='" + summaryStyle + "'>" + summaryText + "</div>";
};

Article.prototype.tweetText = function() {
  return this.tweets[0].text;
};

Article.prototype.tweet = function() {
  return "<div class='tweet'>" + this.tweetText() +"</div>";
};

Article.prototype.source = function() {
  var getUser = function(tweet) { return tweet.user.name; };
  var users = c.map(this.tweets, getUser).join(", ");

  return "<div class='user'>by " + users + "</div>";
};

