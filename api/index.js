'use strict';

// Vercel serverless entry point. vercel.json routes /api/* and /uploads/* here;
// everything in public/ is served directly by Vercel's CDN.
const { createApp } = require('../server/app');

const { app } = createApp({
  databaseUrl: process.env.DATABASE_URL,
  adminPassword: process.env.ADMIN_PASSWORD,
});

module.exports = app;
