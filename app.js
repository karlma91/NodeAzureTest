/*
 * Copyright 2016-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/* jshint node: true, devel: true */
'use strict';

const 
  bodyParser = require('body-parser'),
  config = require('config'),
  crypto = require('crypto'),
  express = require('express'),
  https = require('https'),  
  request = require('request'),
  azure = require('azure-storage');

var nconf = require('nconf');
nconf.env().file({ file: 'config.json', search: true });

var accountName = nconf.get("STORAGE_NAME");
var accountKey = nconf.get("STORAGE_KEY");

var tableservice = azure.createTableService(accountName, accountKey);

var app = express();
app.set('port', process.env.PORT || 5000);
app.set('view engine', 'ejs');
app.use(bodyParser.json({ verify: verifyRequestSignature }));
app.use(express.static('public'));

var messengerToApp = {};

/*
 * Be sure to setup your config values before running this code. You can 
 * set them using environment variables or modifying the config file in /config.
 *
 */

// App Secret can be retrieved from the App Dashboard
const APP_SECRET = (process.env.MESSENGER_APP_SECRET) ? 
  process.env.MESSENGER_APP_SECRET :
  config.get('appSecret');

// Arbitrary value used to validate a webhook
const VALIDATION_TOKEN = (process.env.MESSENGER_VALIDATION_TOKEN) ?
  (process.env.MESSENGER_VALIDATION_TOKEN) :
  config.get('validationToken');

// Generate a page access token for your page from the App Dashboard
const PAGE_ACCESS_TOKEN = (process.env.MESSENGER_PAGE_ACCESS_TOKEN) ?
  (process.env.MESSENGER_PAGE_ACCESS_TOKEN) :
  config.get('pageAccessToken');

// URL where the app is running (include protocol). Used to point to scripts and 
// assets located at this address. 
const SERVER_URL = (process.env.SERVER_URL) ?
  (process.env.SERVER_URL) :
  config.get('serverURL');

if (!(APP_SECRET && VALIDATION_TOKEN && PAGE_ACCESS_TOKEN && SERVER_URL)) {
  console.error("Missing config values");
  process.exit(1);
}

/*
 * Use your own validation token. Check that the token used in the Webhook 
 * setup is the same token used here.
 *
 */
app.get('/webhook', function(req, res) {
  if (req.query['hub.mode'] === 'subscribe' &&
      req.query['hub.verify_token'] === VALIDATION_TOKEN) {
    console.log("Validating webhook");
    res.status(200).send(req.query['hub.challenge']);
  } else {
    console.error("Failed validation. Make sure the validation tokens match.");
    res.sendStatus(403);          
  }  
});

app.get('/test', function (req, res) {
  var tablename = "routerlog";
  var PartitionKey = "Router";
  var RowKey = "00:22:07:47:E8:C7";
  res.writeHead(200, { 'Content-Type': 'application/json' });
  tableservice.retrieveEntity(tablename, PartitionKey, RowKey, function(error, result, response){
    if(!error){
      // result contains the entity
      console.log("Got data");
      res.write(JSON.stringify(result));
      res.end();
    }else{
      console.log("Error getting data");
      res.write(JSON.stringify({hello:'error'}));
      res.end();
    }
  });
  console.log("test");
  //res.write(JSON.stringify({hello:'test'}));
  //res.end();
});

/*
 * All callbacks for Messenger are POST-ed. They will be sent to the same
 * webhook. Be sure to subscribe your app to your page to receive callbacks
 * for your page. 
 * https://developers.facebook.com/docs/messenger-platform/product-overview/setup#subscribe_app
 *
 */
app.post('/webhook', function (req, res) {
  var data = req.body;

  // Make sure this is a page subscription
  if (data.object == 'page') {
    // Iterate over each entry
    // There may be multiple if batched
    data.entry.forEach(function(pageEntry) {
      var pageID = pageEntry.id;
      var timeOfEvent = pageEntry.time;

      // Iterate over each messaging event
      pageEntry.messaging.forEach(function(messagingEvent) {
        if (messagingEvent.optin) {
          receivedAuthentication(messagingEvent);
        } else if (messagingEvent.message) {
          receivedMessage(messagingEvent);
        } else if (messagingEvent.delivery) {
          receivedDeliveryConfirmation(messagingEvent);
        } else if (messagingEvent.postback) {
          receivedPostback(messagingEvent);
        } else if (messagingEvent.read) {
          receivedMessageRead(messagingEvent);
        } else if (messagingEvent.account_linking) {
          receivedAccountLink(messagingEvent);
        } else {
          console.log("Webhook received unknown messagingEvent: ", messagingEvent);
        }
      });
    });

    // Assume all went well.
    //
    // You must send back a 200, within 20 seconds, to let us know you've 
    // successfully received the callback. Otherwise, the request will time out.
    res.sendStatus(200);
  }
});

/*
 * This path is used for account linking. The account linking call-to-action
 * (sendAccountLinking) is pointed to this URL. 
 * 
 */
app.get('/authorize', function(req, res) {
  var accountLinkingToken = req.query['account_linking_token'];
  var redirectURI = req.query['redirect_uri'];

  // Authorization Code should be generated per user by the developer. This will 
  // be passed to the Account Linking callback.
  var authCode = "1234567890";

  // Redirect users to this URI on successful login
  var redirectURISuccess = redirectURI + "&authorization_code=" + authCode;

  res.render('authorize', {
    accountLinkingToken: accountLinkingToken,
    redirectURI: redirectURI,
    redirectURISuccess: redirectURISuccess
  });
});
/*
 * Messegner aut button
 */
app.get('/messenger', function(req, res) {
  var appid = req.query['appid'];
  var routermac = req.query['routermac'];

  res.render('messenger', {
    appid: appid,
    routermac: routermac
  });
});

/*
 * Verify that the callback came from Facebook. Using the App Secret from 
 * the App Dashboard, we can verify the signature that is sent with each 
 * callback in the x-hub-signature field, located in the header.
 *
 * https://developers.facebook.com/docs/graph-api/webhooks#setup
 *
 */
function verifyRequestSignature(req, res, buf) {
  var signature = req.headers["x-hub-signature"];

  if (!signature) {
    // For testing, let's log an error. In production, you should throw an 
    // error.
    console.error("Couldn't validate the signature.");
  } else {
    var elements = signature.split('=');
    var method = elements[0];
    var signatureHash = elements[1];

    var expectedHash = crypto.createHmac('sha1', APP_SECRET)
                        .update(buf)
                        .digest('hex');

    if (signatureHash != expectedHash) {
      throw new Error("Couldn't validate the request signature.");
    }
  }
}

/*
 * Authorization Event
 *
 * The value for 'optin.ref' is defined in the entry point. For the "Send to 
 * Messenger" plugin, it is the 'data-ref' field. Read more at 
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/authentication
 *
 */
function receivedAuthentication(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var timeOfAuth = event.timestamp;

  // The 'ref' field is set in the 'Send to Messenger' plugin, in the 'data-ref'
  // The developer can set this to an arbitrary value to associate the 
  // authentication callback with the 'Send to Messenger' click event. This is
  // a way to do account linking when the user clicks the 'Send to Messenger' 
  // plugin.
  var passThroughParam = event.optin.ref;
  var routermac = passThroughParam.split('_')[0];
  var appid = passThroughParam.split('_')[1];
  var PartitionKey = routermac;
  var RowKey = appid;

  var entGen = azure.TableUtilities.entityGenerator;
  var entity = {
    PartitionKey: entGen.String("Auth"),
    RowKey: entGen.String(senderID),
    routermac: entGen.String(routermac),
    appid: entGen.String(appid),
    recipientID: entGen.String(recipientID)
  };
  console.log("Get pk: " + PartitionKey + " rk: " + RowKey);  
  tableservice.retrieveEntity("RouterAppTable", PartitionKey, RowKey, function(error, result, response){
    if(!error){
      // result contains the entity
      if(result != null){
        console.log("Got app");
        tableservice.retrieveEntity("routerlog", "Router", routermac, function(error, result, response){
          if(!error){
            console.log("Got router");
            var rkey = result.AppAuthKey['_'];
            messengerToApp[senderID] = {routermac: routermac, appid: appid, recipientid: recipientID, key: rkey};
            entity.key = entGen.String(rkey);
            entity.RowKey = entGen.String(senderID);
            console.log("inserting to messengerauth " + JSON.stringify(entity));
            tableservice.insertOrReplaceEntity('MessengerAuth',entity, function (error, result, response) {
              if(!error){
                console.log("Inserted to messengerauth");
              }else{
                console.log("Error inserting to messengerauth: " + JSON.stringify(error));
              }
            });
          }
        });
        sendTextMessage(senderID, "Authentication successful");
      }else{
        sendTextMessage(senderID, "Authentication Failed");
      }
    }else{
      sendTextMessage(senderID, "Authentication Failed");
    }
  });

  console.log("Received authentication for user %d and page %d with pass " +
    "through param '%s' at %d", senderID, recipientID, passThroughParam, 
    timeOfAuth);

  // When an authentication is received, we'll send a message back to the sender
  // to let them know it was successful.
  
}

/*
 * Message Event
 *
 * This event is called when a message is sent to your page. The 'message' 
 * object format can vary depending on the kind of message that was received.
 * Read more at https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-received
 *
 * For this example, we're going to echo any text that we get. If we get some 
 * special keywords ('button', 'generic', 'receipt'), then we'll send back
 * examples of those bubbles to illustrate the special message bubbles we've 
 * created. If we receive a message with an attachment (image, video, audio), 
 * then we'll simply confirm that we've received the attachment.
 * 
 */
function receivedMessage(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var timeOfMessage = event.timestamp;
  var message = event.message;

  console.log("Received message for user %d and page %d at %d with message:", 
    senderID, recipientID, timeOfMessage);
  console.log(JSON.stringify(message));

  var isEcho = message.is_echo;
  var messageId = message.mid;
  var appId = message.app_id;
  var metadata = message.metadata;

  // You may get a text or attachment but not both
  var messageText = message.text;
  var messageAttachments = message.attachments;
  var quickReply = message.quick_reply;

  if(!messengerToApp[senderID] && !messengerToApp[recipientID]){
    var PartitionKey = "Auth";
    var RowKey = senderID;
    console.log("No authentication " + senderID)
    console.log("Getting data from auth " + "MessengerAuth" + " " + PartitionKey + " " + RowKey);
    tableservice.retrieveEntity("MessengerAuth", PartitionKey, RowKey, function(error, result, response){
      if(!error){
        // result contains the entity
        console.log("Got data from table");
        if(result != null){
          console.log("Setting " + JSON.stringify(result));
          messengerToApp[senderID] = {routermac: result["routermac"]["_"], appid: result["appid"]["_"], 
                                    recipientid: result["recipientID"]["_"], key: result["key"]["_"]};
        }else{
          sendTextMessage(senderID, "You are not authenticated");
          return;
        }
      }else{
        sendTextMessage(senderID, "You are not authenticated");
        return;
      }
    });
    sendTextMessage(senderID, "Try again");
    return;
  }

  if (isEcho) {
    // Just logging message echoes to console
    console.log("Received echo for message %s and app %d with metadata %s", 
      messageId, appId, metadata);
      if(message.text == "test"){
            getRouterStatus(senderID);
      }else{
            sendTextMessage(senderID, "Recieved echo");
      }
    return;
  } else if (quickReply) {
    var quickReplyPayload = quickReply.payload;
    console.log("Quick reply for message %s with payload", messageId);

    if(quickReplyPayload.indexOf("RouterMac") !== -1){
        var payload = JSON.parse(quickReplyPayload);
        var auth = messengerToApp[senderID];
        console.log("Sending post_response");
        console.log(JSON.stringify(payload));

      var returntext = '';
      request({
        url: "http://stresstestdomos.azurewebsites.net/v5/app/post_bubble_response",
        method: "POST",
        json: true,
        headers: {
            "content-type": "application/json",
            },
        body: payload
        }, function (error, response, body) {
            if (!error && response.statusCode == 200) {
              console.log("post_response success");
              getBubbles(payload['DialogueID'], senderID, recipientID);
            }else{
              console.log("post_response fail");
            }
        });
        //sendTextMessage(senderID, "You tapped " + message.text);
      }else{
        sendTextMessage(senderID, "Quick reply tapped");
      }
    return;
  }

  if (messageText) {

    // If we receive a text message, check to see if it matches any special
    // keywords and send back the corresponding example. Otherwise, just echo
    // the text we received.
    switch (messageText) {
      case 'image':
        sendImageMessage(senderID);
        break;

      case 'gif':
        sendGifMessage(senderID);
        break;

      case 'audio':
        sendAudioMessage(senderID);
        break;

      case 'video':
        sendVideoMessage(senderID);
        break;

      case 'file':
        sendFileMessage(senderID);
        break;

      case 'button':
        sendButtonMessage(senderID);
        break;

      case 'generic':
        sendGenericMessage(senderID);
        break;

      case 'receipt':
        sendReceiptMessage(senderID);
        break;

      case 'quick':
        sendQuickReply(senderID);
        break;        

      case 'read receipt':
        sendReadReceipt(senderID);
        break;        

      case 'typing on':
        sendTypingOn(senderID);
        break;        

      case 'typing off':
        sendTypingOff(senderID);
        break;        

      case 'account linking':
        sendAccountLinking(senderID);
        break;
        
      case 'show router status':
        getRouterStatus(senderID);
        break;
      case 'dial':
        getDialogues(senderID);
        break;
        
      default:
        //sendTextMessage(senderID, messageText);
    }
  } else if (messageAttachments) {
    sendTextMessage(senderID, "Message with attachment received");
  }
}


/*
 * Delivery Confirmation Event
 *
 * This event is sent to confirm the delivery of a message. Read more about 
 * these fields at https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-delivered
 *
 */
function receivedDeliveryConfirmation(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var delivery = event.delivery;
  var messageIDs = delivery.mids;
  var watermark = delivery.watermark;
  var sequenceNumber = delivery.seq;

  if (messageIDs) {
    messageIDs.forEach(function(messageID) {
      console.log("Received delivery confirmation for message ID: %s", 
        messageID);
    });
  }

  console.log("All message before %d were delivered.", watermark);
}


/*
 * Postback Event
 *
 * This event is called when a postback is tapped on a Structured Message. 
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/postback-received
 * 
 */
function receivedPostback(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var timeOfPostback = event.timestamp;
  if(!messengerToApp[senderID]){
    sendTextMessage(senderID, "not autenticated");
  }
  // The 'payload' param is a developer-defined field which is set in a postback 
  // button for Structured Messages. 
  var payload = event.postback.payload;
  if(payload.indexOf("DIAL") != -1){
    console.log("Received postback for DIAG user %d and page %d with payload '%s' " + 
    "at %d", senderID, recipientID, payload, timeOfPostback);
    var pays = payload.split('_');
    getBubbles(pays[1], senderID, recipientID);
    //sleep(1000);
  }else{
    console.log("Received postback for user %d and page %d with payload '%s' " + 
      "at %d", senderID, recipientID, payload, timeOfPostback);
  }

  // When a postback is called, we'll send a message back to the sender to 
  // let them know it was successful
  //sendTextMessage(senderID, "Postback called");
}

/*
Get all bubbles for a single dialogue
*/
function getBubbles(diagid, senderID, recipientId){
  var auth = messengerToApp[senderID];
  console.log(JSON.stringify(auth));

  var senddata = {
    RouterMac:auth.routermac,
    DeviceMac:auth.appid,
    Key:auth.key,
    DialogueID:diagid,
    NumberOfDialogues:1
  };

var returntext = '';

  request({
    url: "http://stresstestdomos.azurewebsites.net/v5/app/get_dialogue",
    method: "POST",
    json: true,
    headers: {
        "content-type": "application/json",
        },
    body: senddata
    }, function (error, response, body) {
        if (!error && response.statusCode == 200) {
            var code = body.ResponseCode;
            var text = body.ResponseText;
            if(code == "OK"){ // transform data here
              console.log("getBubles: %s", JSON.stringify(text));
              
              var bubbles = text['Bubbles'];
              var sendtext = 'missing';
              var i = 0;
              if(bubbles.length>0)
              {
                sendtext = bubbles[bubbles.length-1]['Text'];
              }
              var messageData = {
                  recipient: {
                    id: recipientId
                  },
                  message: {
                   text:sendtext
                  }
                };  
                console.log("got from Get_dialogues: %s, %s", code, JSON.stringify(messageData));
                //callSendAPI(messageData);
                if(bubbles[bubbles.length-1]['ResponseType']>0){
                  var rt = bubbles[bubbles.length-1]['ResponseType'];
                  var bubbleid = bubbles[bubbles.length-1]['BubbleID']; 
                  var buttons = [];
                  var bubb = bubbles[bubbles.length-1];
                  var payload = { 
                    RouterMac:auth.routermac,
                    DeviceMac:auth.appid,
                    Key:auth.key,
                    DialogueID:diagid,
                    BubbleID:bubbleid,
                    UserResponse:"",
                    OptionValue: 0
                  };
                  if(rt >= 1){
                    payload.OptionValue = ""+bubb['OptionValue1'];
                    buttons.push({
                      "content_type":"text",
                      "title":bubb['OptionLabel1'],
                      "payload":JSON.stringify(payload)
                    });
                  }
                  if(rt >= 2){
                    payload.OptionValue = ""+bubb['OptionValue2'];
                    buttons.push({
                      "content_type":"text",
                      "title":bubb['OptionLabel2'],
                      "payload":JSON.stringify(payload)
                    });
                  }
                  if(rt >= 3){
                    payload.OptionValue = ""+bubb['OptionValue3'];
                    buttons.push({
                      "content_type":"text",
                      "title":bubb['OptionLabel3'],
                      "payload":JSON.stringify(payload)
                    });
                  }
                  sendBubbleWithButton(senderID, sendtext, buttons);
                }else{
                  sendTextMessage(senderID, sendtext);
                }
            }
        }
    });
}

/*
 * Message Read Event
 *
 * This event is called when a previously-sent message has been read.
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-read
 * 
 */
function receivedMessageRead(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;

  // All messages before watermark (a timestamp) or sequence have been seen.
  var watermark = event.read.watermark;
  var sequenceNumber = event.read.seq;

  console.log("Received message read event for watermark %d and sequence " +
    "number %d", watermark, sequenceNumber);
}

/*
 * Account Link Event
 *
 * This event is called when the Link Account or UnLink Account action has been
 * tapped.
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/account-linking
 * 
 */
function receivedAccountLink(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;

  var status = event.account_linking.status;
  var authCode = event.account_linking.authorization_code;

  console.log("Received account link event with for user %d with status %s " +
    "and auth code %s ", senderID, status, authCode);
}

/*
 * Send an image using the Send API.
 *
 */
function sendImageMessage(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "image",
        payload: {
          url: SERVER_URL + "/assets/rift.png"
        }
      }
    }
  };

  callSendAPI(messageData);
}
/*
 * Send an image using the Send API.
 *
 */
function getRouterStatus(recipientId) {
  var senddata = {RouterMac:'00:22:07:47:E8:C7',DeviceMac:'Backdoor1467711068',Key:'1467711068'};
  request({
    url: "http://stresstestdomos.azurewebsites.net/v5/app/get_status",
    method: "POST",
    json: true,
    headers: {
        "content-type": "application/json",
        },
    body: senddata
    }, function (error, response, body) {
        if (!error && response.statusCode == 200) {
            var code = body.ResponseCode;
            var text = body.ResponseText;
            if(code == "OK"){
                sendTextMessage(recipientId, text.RouterStatusText);
            }else{
                sendTextMessage(recipientId, text);
            }
            console.log("got from getrouterstatus: %s, %s", 
            code,text);
    } else {
      console.error(response.error);
    }
  });
}
/*
 * Send an image using the Send API.
 *
 */
function getDialogues(recipientId) {
  
  var auth = messengerToApp[recipientId];
  console.log("getDialogues");
  console.log(JSON.stringify(auth));
  var senddata = {RouterMac:auth.routermac,DeviceMac:auth.appid,Key:auth.key};
  request({
    url: "http://stresstestdomos.azurewebsites.net/v5/app/get_dashboard_dialogues",
    method: "POST",
    json: true,
    headers: {
        "content-type": "application/json",
        },
    body: senddata
    }, function (error, response, body) {
        if (!error && response.statusCode == 200) {
            var code = body.ResponseCode;
            var text = body.ResponseText;
            if(code == "OK"){ // transform data here
                var messageData = {
                  recipient: {
                    id: recipientId
                  },
                  message: {
                    attachment: {
                      type: "template",
                      payload: {
                        template_type: "generic",
                        elements: []
                      }
                    }
                  }
                };  
                var elements = [];
                var diags = text;
                diags.forEach(function(diag) {
                  var element = {
                    title: diag['TitleText'],
                    subtitle: diag['Category'],
                    buttons:[
                      {
                        type:"postback",
                        title:"Start Chatting",
                        payload:"DIAL_" + diag['ID']
                      }
                    ]
                  }
                  if(elements.length<4){
                    elements.push(element);
                  }
                }, this);
                messageData.message.attachment.payload.elements = elements;
                //console.log("got from Get_dialogues: %s, %s", code, JSON.stringify(messageData));
                callSendAPI(messageData);
            }else{
                sendTextMessage(recipientId, text);
            }
           
    } else {
      console.error(response.error);
      sendTextMessage(recipientId, "Error getting dialogues");
    }
  });
}


/*
 * Send a Gif using the Send API.
 *
 */
function sendGifMessage(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "image",
        payload: {
          url: SERVER_URL + "/assets/instagram_logo.gif"
        }
      }
    }
  };

  callSendAPI(messageData);
}

/*
 * Send audio using the Send API.
 *
 */
function sendAudioMessage(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "audio",
        payload: {
          url: SERVER_URL + "/assets/sample.mp3"
        }
      }
    }
  };

  callSendAPI(messageData);
}

/*
 * Send a video using the Send API.
 *
 */
function sendVideoMessage(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "video",
        payload: {
          url: SERVER_URL + "/assets/allofus480.mov"
        }
      }
    }
  };

  callSendAPI(messageData);
}

/*
 * Send a video using the Send API.
 *
 */
function sendFileMessage(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "file",
        payload: {
          url: SERVER_URL + "/assets/test.txt"
        }
      }
    }
  };

  callSendAPI(messageData);
}

/*
 * Send a text message using the Send API.
 *
 */
function sendTextMessage(recipientId, messageText) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      text: messageText,
      metadata: "DEVELOPER_DEFINED_METADATA"
    }
  };
  
  callSendAPI(messageData);
}

/*
 * Send a button message using the Send API.
 *
 */
function sendButtonMessage(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "button",
          text: "This is test text",
          buttons:[{
            type: "web_url",
            url: "https://www.oculus.com/en-us/rift/",
            title: "Open Web URL"
          }, {
            type: "postback",
            title: "Trigger Postback",
            payload: "DEVELOPED_DEFINED_PAYLOAD"
          }, {
            type: "phone_number",
            title: "Call Phone Number",
            payload: "+16505551234"
          }]
        }
      }
    }
  };  

  callSendAPI(messageData);
}

/*
 * Send a Structured Message (Generic Message type) using the Send API.
 *
 */
function sendGenericMessage(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "generic",
          elements: [{
            title: "rift",
            subtitle: "Next-generation virtual reality",
            item_url: "https://www.oculus.com/en-us/rift/",               
            image_url: SERVER_URL + "/assets/rift.png",
            buttons: [{
              type: "web_url",
              url: "https://www.oculus.com/en-us/rift/",
              title: "Open Web URL"
            }, {
              type: "postback",
              title: "Call Postback",
              payload: "Payload for first bubble",
            }],
          }, {
            title: "touch",
            subtitle: "Your Hands, Now in VR",
            item_url: "https://www.oculus.com/en-us/touch/",               
            image_url: SERVER_URL + "/assets/touch.png",
            buttons: [{
              type: "web_url",
              url: "https://www.oculus.com/en-us/touch/",
              title: "Open Web URL"
            }, {
              type: "postback",
              title: "Call Postback",
              payload: "Payload for second bubble",
            }]
          }]
        }
      }
    }
  };  

  callSendAPI(messageData);
}

/*
 * Send a receipt message using the Send API.
 *
 */
function sendReceiptMessage(recipientId) {
  // Generate a random receipt ID as the API requires a unique ID
  var receiptId = "order" + Math.floor(Math.random()*1000);

  var messageData = {
    recipient: {
      id: recipientId
    },
    message:{
      attachment: {
        type: "template",
        payload: {
          template_type: "receipt",
          recipient_name: "Peter Chang",
          order_number: receiptId,
          currency: "USD",
          payment_method: "Visa 1234",        
          timestamp: "1428444852", 
          elements: [{
            title: "Oculus Rift",
            subtitle: "Includes: headset, sensor, remote",
            quantity: 1,
            price: 599.00,
            currency: "USD",
            image_url: SERVER_URL + "/assets/riftsq.png"
          }, {
            title: "Samsung Gear VR",
            subtitle: "Frost White",
            quantity: 1,
            price: 99.99,
            currency: "USD",
            image_url: SERVER_URL + "/assets/gearvrsq.png"
          }],
          address: {
            street_1: "1 Hacker Way",
            street_2: "",
            city: "Menlo Park",
            postal_code: "94025",
            state: "CA",
            country: "US"
          },
          summary: {
            subtotal: 698.99,
            shipping_cost: 20.00,
            total_tax: 57.67,
            total_cost: 626.66
          },
          adjustments: [{
            name: "New Customer Discount",
            amount: -50
          }, {
            name: "$100 Off Coupon",
            amount: -100
          }]
        }
      }
    }
  };

  callSendAPI(messageData);
}

/*
 * Send a message with Quick Reply buttons.
 *
 */
function sendQuickReply(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      text: "What's your favorite movie genre?",
      metadata: "DEVELOPER_DEFINED_METADATA",
      quick_replies: [
        {
          "content_type":"text",
          "title":"Help",
          "payload":"help"
        },
        {
          "content_type":"text",
          "title":"Hello",
          "payload":"Hello"
        },
        {
          "content_type":"text",
          "title":"Drama",
          "payload":"DEVELOPER_DEFINED_PAYLOAD_FOR_PICKING_DRAMA"
        }
      ]
    }
  };

  callSendAPI(messageData);
}
/*
 * Send a message with Quick Reply buttons.
 *
 */
function sendBubbleWithButton(recipientId, text, quickreplies) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      text: text,
      metadata: "DEVELOPER_DEFINED_METADATA",
      quick_replies: quickreplies
    }
  };

  callSendAPI(messageData);
}

/*
 * Send a read receipt to indicate the message has been read
 *
 */
function sendReadReceipt(recipientId) {
  console.log("Sending a read receipt to mark message as seen");

  var messageData = {
    recipient: {
      id: recipientId
    },
    sender_action: "mark_seen"
  };

  callSendAPI(messageData);
}

/*
 * Turn typing indicator on
 *
 */
function sendTypingOn(recipientId) {
  console.log("Turning typing indicator on");

  var messageData = {
    recipient: {
      id: recipientId
    },
    sender_action: "typing_on"
  };

  callSendAPI(messageData);
}

/*
 * Turn typing indicator off
 *
 */
function sendTypingOff(recipientId) {
  console.log("Turning typing indicator off");

  var messageData = {
    recipient: {
      id: recipientId
    },
    sender_action: "typing_off"
  };

  callSendAPI(messageData);
}

/*
 * Send a message with the account linking call-to-action
 *
 */
function sendAccountLinking(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "button",
          text: "Welcome. Link your account.",
          buttons:[{
            type: "account_link",
            url: SERVER_URL + "/authorize"
          }]
        }
      }
    }
  };  

  callSendAPI(messageData);
}

/*
 * Call the Send API. The message data goes in the body. If successful, we'll 
 * get the message id in a response 
 *
 */
function callSendAPI(messageData) {
   console.log("callSendAPI"); 
  request({
    uri: 'https://graph.facebook.com/v2.6/me/messages',
    qs: { access_token: PAGE_ACCESS_TOKEN },
    method: 'POST',
    json: messageData

  }, function (error, response, body) {
    if (!error && response.statusCode == 200) {
      var recipientId = body.recipient_id;
      var messageId = body.message_id;

      if (messageId) {
        console.log("Successfully sent message with id %s to recipient %s", 
          messageId, recipientId);
      } else {
      console.log("Successfully called Send API for recipient %s", 
        recipientId);
      }
    } else {
      console.error("callSendAPI error: %s %s", error, response["body"]["error"]);
    }
  });  
}

// Start server
// Webhooks must be available via SSL with a certificate signed by a valid 
// certificate authority.
app.listen(app.get('port'), function() {
  console.log('Node app is running on port', app.get('port'));
});

module.exports = app;

