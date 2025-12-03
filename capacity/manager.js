const { DynamoDBClient, UpdateItemCommand } = require("@aws-sdk/client-dynamodb");
const { LambdaClient, InvokeCommand } = require("@aws-sdk/client-lambda");

const dynamo = new DynamoDBClient({});
const lambda = new LambdaClient({});

exports.handler = async (event) => {
    // El evento viene del final de la Step Function
    const { kitchenId } = event;

    // 1. Reducir 'used' en DynamoDB
    await dynamo.send(new UpdateItemCommand({
        TableName: process.env.KITCHEN_STATE_TABLE,
        Key: { kitchenId: { S: kitchenId } },
        UpdateExpression: "SET used = used - :dec",
        ConditionExpression: "used > :zero",
        ExpressionAttributeValues: { ":dec": { N: "1" }, ":zero": { N: "0" } }
    }));

    // 2. Invocar DequeueOrder (Disparar y olvidar)
    // Nota: Construimos el nombre de la función basado en el stage
    const funcName = `bemmbos-${process.env.SLS_STAGE || 'dev'}-dequeueOrder`;
    
    await lambda.send(new InvokeCommand({
        FunctionName: funcName,
        InvocationType: "Event", // Asíncrono
        Payload: JSON.stringify({ kitchenId })
    }));

    return event;
};