require("apollo:jquery-binding").install();


var http = require('apollo:http');
var yql = require("apollo:yql");
var s = require("apollo:common").supplant;
var dom = require('apollo:dom');
var date = new Date();
var dow = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
$("h1").html("The "+(date.getHours()||12)+" O'Clock News");


function bitlyExpand(url) {
  return require("apollo:http").jsonp(["http://api.bit.ly/v3/expand", {
    shortUrl: url,
    format: "json",
    login: "onilabs",
    apiKey: "R_3c50e83679a1f77c0a1282f7653f2103"
  }]).data.expand[0];
  //http%3A%2F%2Ftcrn.ch%2Fa4MSUH
  //&shortUrl=http%3A%2F%2Fbit.ly%2F1YKMfY&
  //login=bitlyapidemo&apiKey=R_0da49e0a9118ff35f52f629d2d71bf07&hash=j3&hash=a35.&format=json
}

var user = T.call("users/show", {user_id: T.currentUser.id});

$("#about").html("The twitter links of " + user.name + " on " + dow[date.getDay()]);

waitfor (tweets) { T.User.current().homeTimeline(resume); }

var articles = {};
var link = /(http:\/\/[^ ]+)/g;
$(".tweets").html("<h3>Linkless updates</h3>");
for (var i = 0, tweet; tweet = tweets.array[i]; ++i) {
  var links = tweet.text.match(link);
  if (links && links.length) {
    var url = links[0];
    // expand bit.ly urls
    
    var bl = bitlyExpand(url);
    if (bl.long_url) {
      url = bl.long_url;
    }
    
    var surl = url.replace(/\/$/, "");
    if (articles[surl]) {
      articles[surl].tweets.push(tweet);
      articles[surl].users.push(tweet.user.name);
    } else {
      articles[surl] = {
        tweets: [tweet],
        users: [tweet.user.name],
        url: url
      };
    }
  } else {
    tweet.name = tweet.user.name;
    $(".tweets").append(s("\
      <div class='btweet'>{text}<div class='user'>by {name}</div></div>
    ", tweet));
  } 
}

var pageCheck = {};
var cols = $("#timeline div.col");
for (var url in articles) {
  var article = articles[url];
  console.log(article.url);
  console.log(yql.query("select * from html where url=@url and xpath=@xpath", {
    url:article.url, 
    xpath:"//title[1]|//img[contains(@src,'jpg')]|//meta[@name='description']|//script[contains(.,'hqdefault')]"
  }));
  var html = yql.query("select * from html where url=@url and xpath=@xpath", {
    url:article.url, 
    xpath:"//title[1]|//img[contains(@src,'jpg')]|//meta[@name='description']|//script[contains(.,'hqdefault')]"
  }).results;

  if (!html) {
    continue;
  }
  
  article.img = html.img;
  article.summary = html.meta ? (html.meta.content||"") : "";
  article.tweet = html.title ? "<div class='tweet'>"+article.tweets[0].text+"</div>" : "";
  article.title = html.title ? html.title : article.tweets[0].text;
  article.source = article.users.join(", ");
  if (pageCheck[html.title]) continue; else pageCheck[html.title] = true;// actually need to merge
  if (html.script) {
    // looking for http://i.ytimg.com/vi/lOTtpRAs5FY/hqdefault.jpg
    var m = html.script.content.match(/(http.+?hqdefault.jpg)/);
    if (m && m.length) html.img = [{src: m[0], width:300}];
  }
  
  article.imghtml = "";
  if (html.img && html.img.length) {
    var cimg = null;
    var undefimg = null;
    for (var i = 0, img; img = html.img[i]; ++i) {
      if (img.width == undefined) { undefimg = img; img.width = 0; }
      if (img.id == "main_image") { img.width = 800; article.imgservice = true; }// yfrog
      if (img.width >= 140 && (!cimg || img.width > cimg.width)) cimg = img;
    }
    cimg = cimg || undefimg;
    cimg.src = http.canonicalizeURL(cimg.src, article.url); // could be 
    cimg.extra = article.imgservice ? "height:200px;" : "";
    article.imgurl = cimg.src;
    article.imghtml = s("<div style='background-image:url({src});{extra}' class='illustration'></div>", cimg);
  }
  if (article.summary && article.summary.length > 300) article.summarystyle = "text-align:justify";
  
//  console.log(article.url, article);
  var col;
  $.each(cols, function (i, c) {
    if (!col || $(c).height() < col.height()) {
      col = $(c);
    }
  });
  if (article.imgservice)
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
}

