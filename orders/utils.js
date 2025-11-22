const { v4: uuidv4 } = require('uuid');
const { PutObjectCommand } = require('@aws-sdk/client-s3');
const { s3, BUCKET_NAME } = require('./db');

function response(statusCode, body) {
  return {
    statusCode,
    body: JSON.stringify(body),
  };
}

function parseBody(event) {
  if (!event.body) return {};
  try {
    return JSON.parse(event.body);
  } catch (e) {
    return {};
  }
}

function generateOrderId() {
  // Usa UUID para IDs únicos
  return `ORD-${uuidv4()}`;
}

async function logOrderEvent({ orderId, tenantId, userId, eventType, payload }) {
  try {
    const timestamp = new Date().toISOString();
    const key = `logs/${orderId}#${tenantId}#${userId || 'system'}#${timestamp}.json`;
    const body = JSON.stringify({ orderId, tenantId, userId, eventType, timestamp, payload });
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      Body: body,
      ContentType: 'application/json'
    }));
  } catch (err) {
    console.error('ORDER EVENT LOG ERROR:', err.message || err);
  }
}

function getUserFromEvent(event) {
  // Extrae claims/autorizador (compatibilidad con API Gateway/Lambda authorizer)
  const user = (event.requestContext && event.requestContext.authorizer && event.requestContext.authorizer.claims) || {};
  return user;
}

module.exports = {
  response,
  parseBody,
  generateOrderId,
  getUserFromEvent,
  logOrderEvent,
};
