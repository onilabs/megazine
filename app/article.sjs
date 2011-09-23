var Content = require("./content-extraction");
var logging = require("apollo:logging");
var s = require("apollo:common").supplant;

// -------------------- Article object --------------------

var Article = exports.Article = function(id, url, user, text, pointerURL) {
  this.key = id.toString();
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

  var contents = Content.getURLContents.rateLimited(this.url);

  if (!contents) {
    logging.debug("no contents found for article:" + this);
    this.heading.text = this.url;
    return;
  }
  
  this.contents = contents;
  this.img = Content.extractImage(this.contents, this.url);

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


