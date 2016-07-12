

var express = require('express'),
  config = require('./config/config');

var app = express();

require('./config/express')(app, config);

// for Facebook verification
app.get('/webhook/', function (req, res) {
    if (req.query['hub.verify_token'] === 'my_voice_is_my_password_verify_me') {
        res.send(req.query['hub.challenge'])
    }
    res.send('Error, wrong token')
})

app.listen(config.port, function () {
  console.log('Express server listening on port ' + config.port);
});

