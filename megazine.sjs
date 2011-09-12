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
if(logging.isEnabled(logging.VERBOSE)) {
  require("apollo:debug").console();
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
  logging.debug("expand data:", null, data);
  return data['long-url'];
}
rateLimit(expandUrl, 2);

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
  url = getExpandedURL(url) || url;
  
  // var surl = url.replace(/\/$/, ""); // XXX necessary?
  if (!this.articles[url]) {
    this.articles[url] = {tweets: []};
  }

  this.articles[url].tweets.push(tweet);
};

var getURLContents = exports.getURLContents = function getURLContents(url) {
  var xpath = "//title[1]|//img[contains(@src,'.jpg')]|//meta[@name='description']|//script[contains(.,'hqdefault')]";
  var query = "select * from html where url=@url and xpath=@xpath";

  var result = (yql.query(query, {
    url:url,
    xpath:xpath
  }));

  logging.debug("querying article {url} with xpath {xpath} returns:", {
    url: url,
    xpath: xpath},
    result);

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

function getBestImage(img, baseURL) {
  var large_img = null;
  var unknown_img = null;

  var imgService = false;
  c.each(page.img, function(img) {
    if (img.width == undefined) { unknown_img = img; img.width = 0; }
    if (img.id == "main_image") { img.width = 800; imgservice = true; } // yfrog
    if (img.width >= 140 && (!large_img || img.width > large_img.width)) large_img = img;
  });
  var best_img = large_img || unknown_img;
  if(!best_img) {
    return null;
  }
  var fullURL = http.canonicalizeURL(best_img.src, baseURL);
  return {
    url: fullURL,
    imgervice: imgservice, //XXX remove
    html: s("<div style='background-image:url({src});{extra}' class='illustration'></div>", {
      src: fullURL,
      extraStyle: imgservice ? "height:200px;" : ""
    })
  };
};

function processArticle(article, url) {
  logging.debug("Processing article: {url}", {url:url});

  var html = getURLContents.rateLimited(url);
  if (!html) {
    logging.debug("no html found for url {url}", {url:url});
    return null;
  }
  
  var getUser = function(tweet) { return tweet.user.name; };
  var result = {
    summary: html.meta ? (html.meta.content || "") : "",
    url: url,
    source: c.map(article.tweets, getUser).join(", ")
  };
  if(html.title) {
    result.title = html.title;
    result.tweet = "<div class='tweet'>"+article.tweets[0].text+"</div>";
  } else {
    result.title = article.tweets[0].text;
  }

  //XXX what is this?
  // if (pageCheck[html.title]) {
  //   return null;
  // } else {
  //   pageCheck[html.title] = true;// actually need to merge
  // }

  if (article.summary && article.summary.length > 300) {
    result.summarystyle = "text-align:justify";
  }
  var image = extractImage(article, url);
  if(image) {
  }
  logging.info("processed article: ",null, result);
  return result;
};

function insertArticle(article) {
  logging.debug("inserting article: ",null,article);
  var cols = $("#timeline div.col");
  var col;

  // XXX can we replace this with CSS floats?
  $.each(cols, function (i, c) {
    if (!col || $(c).height() < col.height()) {
      col = $(c);
    }
  });

  if (article.image)
  $(col).append(s("\
    <div class='article'>
      <a href='{url}'>
      <img src='{imgurl}' style='width:100%'/>
      </a>
      <div class='user'>by {source}</div>
      {tweet}
      <div class='summary' style='{summarystyle}'>
        {summary}
      </div>
    </div>
  ", article));
  else
  $(col).append(s("\
    <div class='article'>
      <h3>
        <a href='{url}'>{title}</a>
      </h3>
      <div class='user'>by {source}</div>
      {imghtml}
      {tweet}
      <div class='summary' style='{summarystyle}'>
        {summary}
      </div>
      
    </div>
  ", article));
};

var formatImage = function(img) {
  if(img && img.html) {
    return img.html;
  }
  return "";
};

exports.run = function() {
  $("h1").html("The "+(date.getHours()||12)+" O'Clock News");

  var user = T.call("users/show", {user_id: T.currentUser.id});

  $("#about").html("The twitter links of " + user.name + " on " + dow[date.getDay()]);

  waitfor (var tweets) { T.User.current().homeTimeline(resume); }

  $(".tweets").html("<h3>Linkless updates</h3>");

  logging.verbose("all tweets: ", null, tweets);

  var context = {
    articles: {},
    linklessTweets: []
  };

  c.par.each(tweets.array, processTweet, context);

  c.each(context.linklessTweets, function(tweet) {
    $(".tweets").append(s("<div class='btweet'>{text}<div class='user'>by {name}</div></div>", tweet));
  });

  var pageCheck = {};

  context.articles = c./*par.*/map(context.articles, processArticle);
  // failed summaries return null, so strip them:
  context.articles = c.filter(context.articles, c.identity);

  c.each(context.articles, insertArticle);
};
