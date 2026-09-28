'use strict';

const path = require('path');
const http = require('http');
const { createApp } = require('./app');

const port = Number(process.env.PORT) || 3000;
const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const adminPassword = process.env.ADMIN_PASSWORD || 'admin';
const adminEmail = process.env.ADMIN_EMAIL || undefined;

if (!process.env.ADMIN_PASSWORD) {
  console.warn('⚠️  ADMIN_PASSWORD is not set — using the default password "admin". Set it before going live.');
}
if (!process.env.DATABASE_URL) {
  console.log(`ℹ️  DATABASE_URL is not set — using the embedded local database in ${dataDir}`);
}

const { app, ready, attach } = createApp({ databaseUrl: process.env.DATABASE_URL, dataDir, adminPassword, adminEmail });

const server = http.createServer(app);
attach(server);

ready
  .then(() => {
    server.listen(port, () => {
      console.log(`🎁 Mystery Box running at http://localhost:${port}`);
      console.log(`🛠  Backoffice at        http://localhost:${port}/admin`);
    });
  })
  .catch(() => process.exit(1));
