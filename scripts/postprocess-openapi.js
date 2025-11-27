#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const OPENAPI_PATH = path.resolve(process.cwd(), 'openapi.json');

function safeWrite(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

if (!fs.existsSync(OPENAPI_PATH)) {
  console.error('openapi.json not found at', OPENAPI_PATH);
  process.exit(1);
}

const doc = JSON.parse(fs.readFileSync(OPENAPI_PATH, 'utf8'));

doc.components = doc.components || {};

doc.components.responses = doc.components.responses || {};
doc.components.responses.ErrorResponse = {
  description: 'Error response',
  content: {
    'application/json': {
      schema: {
        type: 'object',
        properties: {
          code: { type: 'string' },
          message: { type: 'string' },
          details: { type: ['object', 'null'] },
        },
      },
      example: {
        code: 'ERR_VALIDATION',
        message: 'Validation failed for field xyz',
        details: null,
      },
    },
  },
};


// Ensure default error responses on each operation
if (doc.paths) {
  for (const [p, methods] of Object.entries(doc.paths)) {
    for (const [m, op] of Object.entries(methods)) {
      // skip non-HTTP keys
      if (!['get','post','put','patch','delete','options','head'].includes(m.toLowerCase())) continue;
      op.responses = op.responses || {};
      // do not overwrite existing responses
      if (!op.responses['400']) op.responses['400'] = { $ref: '#/components/responses/ErrorResponse' };
      if (!op.responses['401']) op.responses['401'] = { $ref: '#/components/responses/ErrorResponse' };
      if (!op.responses['500']) op.responses['500'] = { $ref: '#/components/responses/ErrorResponse' };
    }
  }
}

safeWrite(OPENAPI_PATH, doc);
console.log('Post-processed openapi.json: injected default error responses.');
