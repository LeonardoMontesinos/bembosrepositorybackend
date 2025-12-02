const { EventBridgeClient, PutEventsCommand } = require("@aws-sdk/client-eventbridge");
// Region por defecto
const client = new EventBridgeClient({ region: process.env.AWS_REGION || "us-east-1" });

async function publishEvent(source, type, detail) {
  try {
    const command = new PutEventsCommand({
      Entries: [{
        Source: source,
        DetailType: type,
        Detail: JSON.stringify(detail),
        EventBusName: process.env.EVENT_BUS_NAME || 'default',
        Time: new Date()
      }]
    });
    await client.send(command);
    console.log([EventBridge] Published: ${type});
  } catch (error) {
    console.error([EventBridge] Error publishing ${type}:, error);
  }
}

module.exports = { publishEvent };
