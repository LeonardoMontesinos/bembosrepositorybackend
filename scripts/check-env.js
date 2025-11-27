#!/usr/bin/env node
// Simple env checker: loads .env if present and ensures required vars exist
const fs = require('fs');
try {
  require('dotenv').config();
} catch (e) {
  // dotenv not installed — serverless-dotenv-plugin covers deploy-time, but local checks still useful
}

const required = [
  'JWT_SECRET'
];

const missing = required.filter(k => !process.env[k] || !process.env[k].trim());
if (missing.length) {
  console.error('\nERROR: Missing required environment variables: ' + missing.join(', '));
  console.error('Create a `.env` file in the project root with these variables, or export them in the shell.');
  console.error('\nExample `.env`:\nJWT_SECRET=supersecretvalue\nALLOWED_ORIGINS=*\nCORS_ALLOW_CREDENTIALS=false\n');
  process.exit(1);
}

console.log('Environment check passed — required variables are set.');
process.exit(0);
