require("apollo:jquery-binding").install();
var logging = require("apollo:logging");

var NewsSources = require('./news-sources');

// replace with your own application id:
NewsSources.Twitter.prototype.appId = "hkEsBjNpWsOVKQ2gKyr1kQ";

if(logging.isEnabled(logging.VERBOSE)) {
  // in debug mode, pop up an apollo console
  require("apollo:debug").console({receivelog:false});
}

// The main app controller, initialized by angular.js
var App = exports.App = function App(route) {
  route.when('/twitter', {controller: NewsSources.Twitter, template: "templates/twitter.html"});
  route.when('/hackernews', {controller: NewsSources.HackerNews, template: "templates/hackernews.html"});
  spawn(this.run(route));
};
App.$inject=['$route'];

App.prototype.run = function(route) {
  // every time the route changes, load the appropriate
  // news type (and abort the old news loader if there is one):
  var currentStrata;
  while (true) {
    waitfor() { route.onChange(resume); }
    if(currentStrata) {
      currentStrata.abort();
      currentStrata = null;
    }
    hold(0); // scope seems to be initialized right *after* this code, so we need a delay

    if(!(route.current && route.current.scope)) {
      logging.debug("route changed with no current scope: ", null, route.current);
      continue;
    }

    // init the scope, and run it in the background:
    this.news = route.current.scope;
    this.news._init();
    currentStrata = spawn(this.news.run());
  };
};


