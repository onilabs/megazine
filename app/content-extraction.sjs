var cutil = require('apollo:cutil');
var c = require('apollo:collection');
var logging = require('apollo:logging');
var yql = require('apollo:yql');
var http = require('apollo:http');
var s = require("apollo:common").supplant;

var underscore = require("../lib/underscore.js");
var Cache = require('./cache').Cache;
var imgServiceDomains = ["twitpic.com", "yfrog.com", "imgur.com"];

// -------------------- URL / Image helper functions --------------------

// attach a rate limited version of `fn` to `fn.rateLimited`
function rateLimit(fn, rate) {
  fn.rateLimited = cutil.makeRateLimitedFunction(fn, rate);
};

var getExpandedURL = exports.getExpandedURL = function(url, cache) {
  var cached = cache.get(url);
  if(!cached) {
    cached = {key: url, fullURL: expandUrl.rateLimited(url)};
    cache.save(cached);
  }
  return cached.fullURL;
};

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

rateLimit(getURLContents, 8);

var extractImage = exports.extractImage = function extractImage(page, url) {
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
  // remove src-less images
  var seenSources = [];
  images = c.filter(images, function(img) {
    if(!img.src || underscore.include(seenSources, img.src)) {
      return false;
    }
    seenSources.push(img.src);
    return img.src;
  });

  c.par.each(images, function(img) {
    img.src = http.canonicalizeURL(img.src, baseURL);
    guessImageSize(img);
  });

  // filter out images < 140px; we never want to display them
  images = c.filter(images, function(img) {
    return (img.width === undefined) || (img.width > 140);
  });
  images.sort(imageCompare);

  if(images.length == 0) return null;
  logging.debug("images (worst to best) = ", null, images);

  var best_img = images[images.length-1];
  return new ArticleImage(best_img.src, isImageService(baseURL));
};

function imageCompare(a, b) {
  var criteria = function(img) {
    var isJpeg = img.src.match(/\.jpe?g/);
    var width = img.width ? img.width : 0;
    var height = img.height ? img.height : 100;
    // isJpeg trumps width, jpegs are less likely page decoration
    return [isJpeg ? 1 : 0, width * height];
  }

  var ca = criteria(a);
  var cb = criteria(b);
  if(ca[0]!=cb[0]) return ca[0] - cb[0];
  return ca[1] - cb[1];
};

function guessImageSize(img) {
  if(img.width) return;
  var match;

  // guess based on style attribute (accurate but uncommon)
  var styleRe = /(?:^|[^-])width: *(\d+)px/;
  match = (img.style && img.style.match(styleRe));
  if(match) {
    logging.debug("guessed image width of " + match[1] + " based on style string: " + img.style + " for url " + img.src, null, match);
    img.width = parseInt(match[1]);
    img.height = img.width; // not correct, but roughly accurate
    return;
  };

  // guess based on URL params (inaccurate)
  var sizeRe = /(?:x|w|xsize|size|width)=(\d+)/;
  match = img.src.match(sizeRe);
  if(match) {
    logging.debug("guessed image width of " + match[1] + " based on url: " + img.src);
    img.width = parseInt(match[1]);
    img.height = img.width; // not correct, but roughly accurate
    return;
  }

  // last (bandwidth-intensive) resort: actually load it...
  try {
    var loaded = loadImage(img.src, 5);
    img.width = loaded.width;
    img.width = loaded.height;
  } catch (e) {
    logging.debug("failed to load image: " + e);
  }
};

var loadImage = exports.loadImage = cutil.makeMemoizedFunction(function(url, timeout) {
  var domImg = new Image();
  timeout = timeout || 5;
  try {
    waitfor() {
      domImg.onload = resume;
    }
    logging.debug("loaded image {src} to find that its width is {width}", domImg);
    return domImg;
  } or {
    domImg.src=url;
    hold(timeout * 1000);
    throw new Error("Image " + url + " failed to load in " + timeout + "s");
  }
});


function isImageService(url) {
  var domain = http.parseURL(url).authority;
  domain = domain.replace(/^wwww\./, ''); // strip leading www
  return imgServiceDomains.indexOf(domain) !== -1;
};


var ArticleImage = exports.ArticleImage = function ArticleImage(src, imgService) {
  this.src = src;
  this.imgService = imgService;
  this.style = {
    'background-image': s('url({src})', this),
  };
  if(imgService) {
    this.style.height = 200;
  }
};
ArticleImage.prototype.toString = function() { return s("<ArticleImage: {src}>", this); };

