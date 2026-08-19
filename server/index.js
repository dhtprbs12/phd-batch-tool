const path = require('path');
const fs = require('fs');

// Load .env
const envPath = path.resolve(__dirname, '../.env');
if (fs.existsSync(envPath)) require('dotenv').config({ path: envPath });
else require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { connectDB } = require('./services/connection');
const routes = require('./routes');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// Serve built client (production)
const clientDist = path.join(__dirname, '../client/dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
}

app.use('/api/batch', routes);

// SPA fallback — serve index.html for non-API routes
if (fs.existsSync(clientDist)) {
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api/')) {
      res.sendFile(path.join(clientDist, 'index.html'));
    }
  });
}

// Initialize DB then start server
connectDB().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Batch Tool server running on port ${PORT}`);
  });
}).catch(err => {
  console.error('❌ Failed to connect to DB:', err.message);
  process.exit(1);
});
