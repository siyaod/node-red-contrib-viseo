const { ActivityHandler, MessageFactory } = require("botbuilder");

class VBMBot extends ActivityHandler {
  constructor(node, appId, welcomeMessage, sendWelcomeMessage, sendReactionMessage, conversationState, skillsConfig, skillClient) {
    super();

    if (node) {
      this.node = node;
    }

    if(sendReactionMessage){
      this.sendReactionMessage = sendReactionMessage;
    }
    
    if(sendWelcomeMessage){
      this.sendWelcomeMessage = sendWelcomeMessage;
    }

    if (conversationState) {
      this.conversationState = conversationState;
    }
    if (skillsConfig) {
      this.skillsConfig = skillsConfig;
    }
    if (skillClient) {
      this.skillClient = skillClient;
    }

    this.botId = appId;
      this.onMembersAdded(async (context, next) => {
        const membersAdded = context.activity.membersAdded;

        for (let cnt = 0; cnt < membersAdded.length; cnt++) {
          if (membersAdded[cnt].name === "") {
            return await new Promise(function (resolve, reject) {
              context.activity.type = "message";
              context.activity.text = "Cmd-Start";
              sendWelcomeMessage(node, context, resolve, reject, next);
            });
         }
       }
        await next();
      });
  }
  

  async onReactionsAddedActivity(reactionsAdded, context) {
    for (var i = 0, len = reactionsAdded.length; i < len; i++) {
      
      context.activity.type = "messageReaction";
      this.sendReactionMessage(this.node,context);
     }
    };

  // Override the ActivityHandler.run() method to save state changes
  async run(context) {
    await super.run(context);
    if (this.conversationState) await this.conversationState.saveChanges(context, false);
  }

  // route the activity to the skill
  async sendToSkill(activity, targetSkill) {
    if (typeof activity === 'undefined') {
      throw new Error(`[Botbuilder]: cannot find activity to send to skill`);
    }
    if (typeof targetSkill === 'undefined') {
      throw new Error(`[Botbuilder]: cannot find skill to send activity`);
    }

    const response = await this.skillClient.postToSkill(this.botId, targetSkill, this.skillsConfig.hostEndpoint, activity);

    if (!(response.status >= 200 && response.status <= 499)) {
      throw new Error(`[Botbuilder]: cannot invoke skill with appId: "${targetSkill.appId}" \r\nat "${targetSkill.skillEndpoint}" \r\n(status is ${response.status}). \r\n ${response.body}`);
    }
  }

}

module.exports.VBMBot = VBMBot;