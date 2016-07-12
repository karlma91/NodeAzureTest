var express = require('express'),
  router = express.Router(),
  Article = require('../models/article');

module.exports = function (app) {
  app.use('/', router);
};
// for Facebook verification
router.get('/webhook/', function (req, res) {
    if (req.query['hub.verify_token'] === 'testtoken') {
        res.send(req.query['hub.challenge'])
    }
    res.send('Error, wrong token')
})
router.get('/', function (req, res, next) {
  var articles = [new Article(), new Article()];
    res.render('index', {
      title: 'Generator-Express MVC',
      articles: articles
    });
});

