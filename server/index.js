'use strict';

const path = require('path');
const { createApp } = require('./app');

const port = Number(process.env.PORT) || 3000;
const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const adminPassword = process.env.ADMIN_PASSWORD || 'admin';

if (!process.env.ADMIN_PASSWORD) {
  console.warn('⚠️  ADMIN_PASSWORD is not set — using the default password "admin". Set it before going live.');
}
if (!process.env.DATABASE_URL) {
  console.log(`ℹ️  DATABASE_URL is not set — using the embedded local database in ${dataDir}`);
}

const { app, ready } = createApp({ databaseUrl: process.env.DATABASE_URL, dataDir, adminPassword });

ready
  .then(() => {
    app.listen(port, () => {
      console.log(`🎁 Mystery Box running at http://localhost:${port}`);
      console.log(`🛠  Backoffice at        http://localhost:${port}/admin`);
    });
  })
  .catch(() => process.exit(1));
