const { DynamoDBClient, QueryCommand } = require('@aws-sdk/client-dynamodb');
const { json } = require('../http');

const dynamo = new DynamoDBClient({});
const MENU_TABLE = process.env.MENU_TABLE || 'MenuTable'; // PK=tenantId, SK=dishId

exports.handler = async (event) => {
	try {
		const tenantId = (event.queryStringParameters && event.queryStringParameters.tenantId) || null;
		if (!tenantId) {
			return json(400, { message: 'tenantId query param required' }, event);
		}

		const result = await dynamo.send(new QueryCommand({
			TableName: MENU_TABLE,
			KeyConditionExpression: 'tenantId = :t',
			ExpressionAttributeValues: { ':t': { S: tenantId } },
		}));

		const dishes = (result.Items || []).map(d => ({
			dishId: d.dishId.S,
			name: d.name?.S,
			description: d.description?.S,
			price: Number(d.price?.N || 0),
			available: d.available ? !!d.available.BOOL : true,
			imageUrl: d.imageUrl?.S || null,
		})).filter(d => d.available);

		return json(200, { dishes }, event);
	} catch (err) {
		console.error('GET MENU ERROR:', err);
		return json(500, { message: 'Server error', error: err.message }, event);
	}
};
