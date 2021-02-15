const { BotFrameworkAdapter, TurnContext, MemoryStorage, ConversationState, SkillHttpClient, SkillHandler, ChannelServiceRoutes, ActivityTypes } = require("botbuilder");
const { SimpleCredentialProvider, AuthenticationConfiguration } = require('botframework-connector');
const { VBMBot } = require("./botVBM");
const getMessage = require("./messages.js");
const { SkillsConfiguration } = require('./skillsConfiguration');
const { SkillConversationIdFactory } = require('./skillConversationIdFactory');
const { AllowedCallersClaimsValidator } = require('./allowedCallersClaimsValidator');
const helper = require("node-red-viseo-helper");
const botmgr = require("node-red-viseo-bot-manager");

let adapter;
let bot;
let skillEndpoint;
let authConfig;
let botbuilderConfig = {
    appId: '',
    appPassword: '',
    authConfig
};


const getAuthConfig = (allowedSkills) => {
  const allowedCallersClaimsValidator = new AllowedCallersClaimsValidator(allowedSkills);

  return new AuthenticationConfiguration([], (claims) => {
    allowedCallersClaimsValidator.validateClaims(claims);
  });
};

async function initConnector(config, node, startCmd) {
  return new Promise( function (resolve, reject) {
    const memoryStorage = new MemoryStorage();
    const conversationState = new ConversationState(memoryStorage);
    const ifRootBot = typeof config.rootAppId === 'undefined' || config.rootAppId === '';

    // create bot framework adapter with bot config
    authConfig = getAuthConfig(config.allowedCallers);
    botbuilderConfig = {
      appId: config.appId,
      appPassword: config.appPassword,
      authConfig
    };
    adapter = new BotFrameworkAdapter(botbuilderConfig);
    // create bot
    if (ifRootBot) {
      const conversationIdFactory = new SkillConversationIdFactory();
      const skillsConfig = new SkillsConfiguration(config.allowedCallers, config.skillHostEndpoint);
      const credentialProvider = new SimpleCredentialProvider(config.appId, config.appPassword);
      const skillClient = new SkillHttpClient(credentialProvider, conversationIdFactory);
      bot = new VBMBot(node, config.appId, startCmd, sendWelcomeMessage, conversationState, skillsConfig, skillClient);

      // Init skills if root bot
      const skillHandler = new SkillHandler(adapter, bot, conversationIdFactory, credentialProvider, authConfig);
      skillEndpoint = new ChannelServiceRoutes(skillHandler);

    } else {
      bot = new VBMBot(node, config.appId, startCmd, null, conversationState);
    }

    // Handle turn error
    adapter.onTurnError = async (context, error) => {
      console.error(`\n [BotBuilder]: ${ JSON.stringify(error, null, 2) }`);
  
      // Send a trace activity, which will be displayed in Bot Framework Emulator
      await context.sendTraceActivity(
        'OnTurnError Trace',
        `${ error }`,
        'https://www.botframework.com/schemas/error',
        'TurnError'
      );
      const conversationReference = TurnContext.getConversationReference(context.activity);
      await context.adapter.sendActivities(context, [
          TurnContext.applyConversationReference({ 
            type: ActivityTypes.Message,
            text: 'The bot encountered an error or bug. To continue to run this bot, please fix the bot source code.'
          }, conversationReference)]);
  };

    // Handle incoming message
    bot.onMessage(async (context, next) => {
      const text = context.activity.text;

      if (ifRootBot) {
        const activeSkill = bot.skillsConfig.skills[text];
        if (activeSkill) {
          await bot.sendToSkill(context.activity, activeSkill);
          await next();
        }
      }
      
      await new Promise(function(resolve, reject) {
        receive(node, config, context, bot);
        resolve();
      });

      await next();
    });
  
    let handleReceive = function (req, res) {
      adapter.processActivity(req, res, async context => {
        await bot.run(context);
      });
    }

    if (ifRootBot) {
      resolve({ handleReceive, reply, skillEndpoint});
    } else {
      resolve({ handleReceive, reply});
    }
  });
}

module.exports.initConnector = initConnector;

// -------------------------------------------------------------------------
function buildMessageFlow(activity) {
  // Fix
  let message = activity;
  if (!message.serviceUrl) return;

  message.user = message.from;
  message.address = { 
    conversation: message.conversation,
    id: message.id,
    serviceUrl: message.serviceUrl,
    channelId: message.channelId
  };

  if (message.recipient) {
    message.address.bot = {
      id: message.recipient.id,
      name: message.recipient.name
    }
  }
  // Build data
  let data = botmgr.buildMessageFlow(
    {
      message: JSON.parse(JSON.stringify(message)),
      payload: message.text,
      user: message.from
    },
    { agent: "botbuilder" }
  );

  return data;
}

async function receive(node, config = {}, context, bot) {
  // Log activity
  try {
    setTimeout(function() {
      helper.trackActivities(node);
    }, 0);
  } catch (err) {
    console.error("[BotBuilder]", err);
  }

  let data = buildMessageFlow(context.activity);

  data.botbuilder = {
    bot,
    activity: context.activity
  };

  // Add context object to store the lifetime of the stream
  let convId = botmgr.getConvId(data);
  let ref = TurnContext.getConversationReference(context.activity);
  let _context = botmgr.getContext(data);
  _context.convRef = ref;

  // Handle Prompt
  if (botmgr.hasDelayedCallback(convId, data.message)) {
    return;
  }

  // Send message
  _context.lastMessageDate = data.message.timestamp;
  helper.emitEvent("received", node, data, config);

  node.send([null, data]);
}

module.exports.receive = receive;

async function reply(node, data, globalTypingDelay) {
  //check it's the last message
  let context = botmgr.getContext(data);

  let timestamp = data.message.timestamp;
  if (timestamp) timestamp = new Date(timestamp).valueOf();

  let timeContext = context.lastMessageDate;
  if (timeContext) timeContext = new Date(timeContext).valueOf();
  if (timestamp && timestamp !== timeContext) return false;

  // Assume we send the message to the current user address
  let address = botmgr.getUserAddress(data);
  if (!address || address.carrier !== "botbuilder") return false;

  // Building the message
  let message = {};
  let callback = () => {
    try {
      helper.fireAsyncCallback(data);
    }
    catch(err) {
      console.error("[BotBuilder]", err);
    };
  }

  if (data.customReply) {
    message = data.customReply;
    message.address = address;
    // message.data = {
    //   type: message.type
    // };
    message = [message];
  } 
  else if (data.reply.length === 0) {
    return callback();
  } 
  else {
    message = getMessage(
      node,
      address,
      data.reply,
      globalTypingDelay,
      timestamp == undefined
    );

    if (!message) return false;

    message.forEach(m => {
      m.address = address;
      if (data.metadata) {
        if (!m.value) m.value = {};
        m.value = data.metadata;
      }
    });
  }

  let reference = context.convRef;
  await adapter.continueConversation(reference, async (_cont) => {
    await _cont.sendActivities(message);
  });

  return callback();
}

async function sendWelcomeMessage(node, context, resolve, reject, next) {
  let data = buildMessageFlow(context.activity);
  data.message = {};

  let ref = TurnContext.getConversationReference(context.activity);
  let _context = botmgr.getContext(data);
  _context.convRef = ref;
  _context.next = next;

  resolve();
  node.send([data, null]);
}