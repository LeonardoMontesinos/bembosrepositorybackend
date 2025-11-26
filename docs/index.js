"use strict";
const fs = require('fs');
const path = require('path');

module.exports.handler = async (event) => {
  // AWS API Gateway may provide event.path or event.rawPath depending on type
  const requestPath = event.path || event.rawPath || '/';
  try {
    if (requestPath.endsWith('openapi.json')) {
      const filePath = path.join(__dirname, '..', 'openapi.json');
      const data = fs.readFileSync(filePath, 'utf8');
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: data,
      };
    }
  } catch (err) {
    return { statusCode: 404, body: 'openapi.json not found' };
  }

  // Serve a minimal Swagger UI page that loads the generated spec
  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/4.18.0/swagger-ui.css" />
    <title>Bembos API Docs</title>
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/4.18.0/swagger-ui-bundle.min.js"></script>
    <script>
      window.onload = function() {
        const specUrl = (window.location.pathname.endsWith('/') ? './openapi.json' : './openapi.json');
        SwaggerUIBundle({
          url: specUrl,
          dom_id: '#swagger-ui',
        });
      };
    </script>
  </body>
</html>`;

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/html' },
    body: html,
  };
};
