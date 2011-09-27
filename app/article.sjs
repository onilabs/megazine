var Content = require("./content-extraction");
var logging = require("apollo:logging");
var s = require("apollo:common").supplant;
var underscore = require("../lib/underscore.js");

// -------------------- Article object --------------------

// var Article = exports.Article = function(id, url, user, text, pointerURL) {
var Article = exports.Article = function(props) {
  props = underscore.clone(props);
  function prop(name, _default) {
    if(!(name in props)) {
      if(_default !== undefined) return _default;
      throw new Error("required property " + name + " not provided");
    }
    var val = props[name];
    delete props[name];
    return val;
  }

  var id = prop('id');
  var user = prop('user', null);

  this.key = 'article_' + id.toString(); // workaround lawnchair bug #58
  this.users = [];
  if(user) this.users.push(user);

  this.url = prop('url');
  this.pointerText = prop('text', null);
  this.pointerURL = prop('pointerURL', null);

  this.contentOverrides = {
    title: prop('title', null),
    summary: prop('content', null)
  };

  if(underscore.keys(props).length > 0) {
    throw new Error("unknown properties: " + underscore.keys(props).join(", "));
  }
};

Article.prototype.addUser = function(user) {
  this.users.push(user);
};

Article.prototype.update = function(opts) {
  if(opts.user) this.addUser(opts.user);
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
  logging.debug("got article contents for {url}:", this, contents);

  if(this.contentOverrides.title) contents.title = this.contentOverrides.title;
  
  this.contents = contents;
  this.img = Content.extractImage(this.contents, this.url);

  if(this.img && this.img.imgService) {
    this.heading.image = this.img.src;
    this.contextImage = null;
  } else {
    this.contextImage = this.img;
    this.populateTitle();
  }
  this.summary = this.getSummary(this.contentOverrides.summary);
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

Article.prototype.getSummary = function(override) {
  var maxlen = 250;
  var text = override || (this.contents.meta && this.contents.meta.content);
  if(!text) return;
  text = text.replace(/<[^>]*(>|$)/g, '')
  var summary = {
    text: text,
    style: {}
  };

  if (summary.text.length > maxlen) {
    summary.style['text-align'] = "justify";
    summary.text = summary.text.slice(0, maxlen).replace(/&[^;]*$/) + "&hellip;";
  }
  return summary;
};


