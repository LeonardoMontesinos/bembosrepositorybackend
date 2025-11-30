const { handleCreate } = require('./create');
const { handleList } = require('./list');
const { handleGet } = require('./get');
//const { handleCancel } = require('./cancel');
const { getUserFromEvent, response } = require('./utils');

// Export individual handlers for Serverless functions
async function create(event) {
  const user = getUserFromEvent(event);
  return handleCreate(event, user);
}

async function list(event) {
  const user = getUserFromEvent(event);
  return handleList(event, user);
}

async function get(event) {
  const user = getUserFromEvent(event);
  return handleGet(event, user);
}

//async function cancel(event) {
  //const user = getUserFromEvent(event);
  //return handleCancel(event, user);
//}

async function updateStatus(event) {
  const user = getUserFromEvent(event);
  const { handleUpdateStatus } = require('./updateStatus');
  return handleUpdateStatus(event, user);
}

// Backwards-compatible single handler
async function handler(event) {
  const method = event.httpMethod;
  const path = event.path || '';
  const user = getUserFromEvent(event);

  try {
    if (method === 'POST' && path === '/orders') return await create(event);
    if (method === 'GET' && path === '/orders') return await list(event);
    if (method === 'GET' && /^\/orders\/[^/]+$/.test(path)) return await get(event);
   // if (method === 'DELETE' && /^\/orders\/[^/]+$/.test(path)) return await cancel(event);

    return response(404, { message: 'Route not found' });
  } catch (err) {
    console.error('Orders handler error:', err);
    return response(500, { error: err.message });
  }
}

module.exports = { create, list, get, updateStatus, handler };