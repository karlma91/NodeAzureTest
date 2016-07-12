

var express = require('express'),
  config = require('./config/config');

var app = express();

require('./config/express')(app, config);

// for Facebook verification
app.get('/webhook/', function (req, res) {
    if (req.query['hub.verify_token'] === 'testtoken') {
        res.send(req.query['hub.challenge'])
    }
    res.send('Error, wrong token')
})

app.listen(config.port, function () {
  console.log('Express server listening on port ' + config.port);
});

