/**
 * Master Fit - Combined Server (MongoDB版)
 * 
 * Serves both the API and the static frontend.
 * For production with multiple servers, split into API server + static file hosting.
 * 
 * Usage:
 *   node server.js
 * 
 * Environment variables:
 *   PORT=3000 (default)
 *   STATIC_DIR=./public (directory containing index.html)
 *   MONGODB_URI=mongodb://localhost:27017 (required)
 *   DB_NAME=masterfit (default)
 */

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { MongoClient, ObjectId } = require('mongodb');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATIC_DIR = process.env.STATIC_DIR || path.join(__dirname, 'public');
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME || 'masterfit';

if (!MONGODB_URI) {
  console.error('ERROR: MONGODB_URI environment variable is required');
  process.exit(1);
}

// MongoDB client and db references
let client;
let db;
let clientsCollection;
let messagesCollection;
let appointmentsCollection;
let dingtalkSyncsCollection;

async function connectDB() {
  if (db) return true;

  try {
    client = new MongoClient(MONGODB_URI, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
    });
    await client.connect();
    db = client.db(DB_NAME);
    clientsCollection = db.collection('clients');
    messagesCollection = db.collection('messages');
    appointmentsCollection = db.collection('appointments');
    dingtalkSyncsCollection = db.collection('dingtalk_syncs');

    // Create indexes
    try {
      await clientsCollection.createIndex({ 'formData.clientBasics.phone': 1 });
      await clientsCollection.createIndex({ branch: 1 });
      await clientsCollection.createIndex({ createdAt: -1 });
      await messagesCollection.createIndex({ clientPhone: 1 });
      await messagesCollection.createIndex({ createdAt: -1 });
      await appointmentsCollection.createIndex({ clientPhone: 1 });
      await appointmentsCollection.createIndex({ createdAt: -1 });
    } catch (e) {
      console.log('Index creation skipped (may already exist):', e.message);
    }

    console.log('MongoDB connected successfully');
    return true;
  } catch (error) {
    console.error('MongoDB connection error:', error.message);
    return false;
  }
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ==================== API ROUTES ====================

// Health check
app.get('/api/health', async (req, res) => {
  const mongoOk = db ? true : false;
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    storage: 'mongodb',
    mongodb: mongoOk ? 'connected' : 'disconnected',
    version: '2.1.0'
  });
});

// Create or update client
app.post('/api/clients', async (req, res) => {
  try {
    const { id, branch, formData, isSubmission } = req.body;

    if (!branch || !formData) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const clientData = {
      branch,
      formData,
      updatedAt: new Date().toISOString()
    };

    // If a real MongoDB id was already given, always update that exact record.
    if (id && ObjectId.isValid(id)) {
      const updateOps = { $set: { ...clientData, updatedAt: new Date().toISOString() } };
      // Only a genuine form submission (not an autosave-on-keystroke) counts as a visit.
      if (isSubmission) updateOps.$inc = { visitCount: 1 };
      const result = await clientsCollection.findOneAndUpdate(
        { _id: new ObjectId(id) },
        updateOps,
        { returnDocument: 'after' }
      );
      return res.json({ data: result });
    }

    const phone = formData.clientBasics?.phone || '';

    // FIX: Do not create or match a record while the phone number is
    // still incomplete (fewer than 7 digits). This prevents duplicate
    // "junk" records from being created on every keystroke before the
    // client finishes typing their phone number. We still return a
    // success response with a temporary in-memory object (not saved)
    // so the frontend doesn't error out — it just won't persist until
    // the phone number is long enough or a real id exists.
    const digitsOnly = phone.replace(/\D/g, '');
    if (digitsOnly.length > 0 && digitsOnly.length < 7) {
      return res.json({
        data: {
          _id: null,
          branch,
          formData,
          updatedAt: new Date().toISOString(),
          _pending: true
        }
      });
    }

    // Check for existing client by phone (only once phone is complete enough)
    if (phone) {
      const existing = await clientsCollection.findOne({
        'formData.clientBasics.phone': phone
      });
      if (existing) {
        const updateOps = { $set: { ...clientData, updatedAt: new Date().toISOString() } };
        if (isSubmission) updateOps.$inc = { visitCount: 1 };
        await clientsCollection.updateOne({ _id: existing._id }, updateOps);
        const updated = await clientsCollection.findOne({ _id: existing._id });
        return res.json({ data: updated });
      }
    }

    // Insert new client
    const newClient = {
      ...clientData,
      visitCount: isSubmission ? 1 : 0,
      createdAt: new Date().toISOString()
    };
    const result = await clientsCollection.insertOne(newClient);
    const saved = await clientsCollection.findOne({ _id: result.insertedId });
    res.json({ data: saved });
  } catch (error) {
    console.error('Error saving client:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get client by phone
app.get('/api/clients/phone/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    const client = await clientsCollection.findOne(
      { 'formData.clientBasics.phone': phone },
      { sort: { createdAt: -1 } }
    );

    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    res.json({ data: client });
  } catch (error) {
    console.error('Error finding client:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get all clients
app.get('/api/clients', async (req, res) => {
  try {
    const { branch, search } = req.query;

    let query = {};
    if (branch) query.branch = branch;
    if (search) {
      query.$or = [
        { 'formData.clientBasics.name': { $regex: search, $options: 'i' } },
        { 'formData.clientBasics.phone': { $regex: search, $options: 'i' } }
      ];
    }

    const clients = await clientsCollection
      .find(query)
      .sort({ createdAt: -1 })
      .limit(100)
      .toArray();

    res.json({ data: clients });
  } catch (error) {
    console.error('Error fetching clients:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get single client
app.get('/api/clients/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid client ID' });
    }

    const client = await clientsCollection.findOne({ _id: new ObjectId(id) });

    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    res.json({ data: client });
  } catch (error) {
    console.error('Error fetching client:', error);
    res.status(500).json({ error: error.message });
  }
});

// Send message
app.post('/api/messages', async (req, res) => {
  try {
    const { clientPhone, from, message, type = 'feedback' } = req.body;

    if (!clientPhone || !message) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const messageData = {
      clientPhone,
      from: from || 'Staff',
      message,
      type,
      createdAt: new Date().toISOString()
    };

    const result = await messagesCollection.insertOne(messageData);
    const saved = await messagesCollection.findOne({ _id: result.insertedId });
    res.json({ data: saved });
  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get messages for client
app.get('/api/messages/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    const clientMessages = await messagesCollection
      .find({ clientPhone: phone })
      .sort({ createdAt: -1 })
      .toArray();

    res.json({ data: clientMessages });
  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create appointment
app.post('/api/appointments', async (req, res) => {
  try {
    const { clientPhone, date, time, branch } = req.body;

    if (!clientPhone || !date) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Replace any existing appointment for this client
    await appointmentsCollection.deleteMany({ clientPhone });

    const appointmentData = {
      clientPhone,
      date,
      time: time || '',
      branch: branch || '',
      reminderSent: false,
      createdAt: new Date().toISOString()
    };

    const result = await appointmentsCollection.insertOne(appointmentData);
    const saved = await appointmentsCollection.findOne({ _id: result.insertedId });
    res.json({ data: saved });
  } catch (error) {
    console.error('Error creating appointment:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get appointment for client
app.get('/api/appointments/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    const appointment = await appointmentsCollection.findOne(
      { clientPhone: phone },
      { sort: { createdAt: -1 } }
    );

    res.json({ data: appointment || null });
  } catch (error) {
    console.error('Error fetching appointment:', error);
    res.status(500).json({ error: error.message });
  }
});

// DingTalk sync
app.post('/api/dingtalk/sync', async (req, res) => {
  try {
    const { client } = req.body;

    if (!client) {
      return res.status(400).json({ error: 'Missing client data' });
    }

    const syncData = {
      client,
      syncedAt: new Date().toISOString()
    };

    await dingtalkSyncsCollection.insertOne(syncData);

    console.log('DingTalk sync logged:', client.formData?.clientBasics?.name || 'Unknown');
    res.json({ success: true, syncedAt: new Date().toISOString() });
  } catch (error) {
    console.error('Error syncing to DingTalk:', error);
    res.status(500).json({ error: error.message });
  }
});

// Add pain record
app.post('/api/clients/:id/pain', async (req, res) => {
  try {
    const { id } = req.params;
    const { painData } = req.body;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid client ID' });
    }

    const result = await clientsCollection.findOneAndUpdate(
      { _id: new ObjectId(id) },
      {
        $push: {
          painHistory: {
            ...painData,
            recordedAt: new Date().toISOString()
          }
        },
        $set: { updatedAt: new Date().toISOString() }
      },
      { returnDocument: 'after' }
    );

    if (!result) {
      return res.status(404).json({ error: 'Client not found' });
    }

    res.json({ data: result });
  } catch (error) {
    console.error('Error adding pain record:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get pain history
app.get('/api/clients/:id/pain', async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid client ID' });
    }

    const client = await clientsCollection.findOne(
      { _id: new ObjectId(id) },
      { projection: { painHistory: 1 } }
    );

    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    res.json({ data: client.painHistory || [] });
  } catch (error) {
    console.error('Error fetching pain history:', error);
    res.status(500).json({ error: error.message });
  }
});

// Add a returning-client "has this improved?" check-in response
app.post('/api/clients/:id/checkin', async (req, res) => {
  try {
    const { id } = req.params;
    const { response, priorZone, priorSeverity } = req.body;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid client ID' });
    }
    if (!['yes', 'somewhat', 'no'].includes(response)) {
      return res.status(400).json({ error: 'Invalid response value' });
    }

    const result = await clientsCollection.findOneAndUpdate(
      { _id: new ObjectId(id) },
      {
        $push: {
          checkins: {
            response,
            priorZone: priorZone || null,
            priorSeverity: priorSeverity ?? null,
            respondedAt: new Date().toISOString()
          }
        }
      },
      { returnDocument: 'after' }
    );

    if (!result) {
      return res.status(404).json({ error: 'Client not found' });
    }

    res.json({ data: result });
  } catch (error) {
    console.error('Error saving check-in:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== STATIC FILES ====================

// Serve static files from public directory
if (fs.existsSync(STATIC_DIR)) {
  app.use(express.static(STATIC_DIR));
}

// Serve index.html for all other routes (SPA support)
app.get('*', (req, res) => {
  const indexPath = path.join(STATIC_DIR, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send('index.html not found in ' + STATIC_DIR);
  }
});

// ==================== STARTUP ====================

async function start() {
  const connected = await connectDB();
  if (!connected) {
    console.error('Failed to connect to MongoDB. Exiting.');
    process.exit(1);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`
Master Fit - Full Stack Server (MongoDB) - Running on port ${PORT}
API: http://localhost:${PORT}/api
Frontend: http://localhost:${PORT}
Health: http://localhost:${PORT}/api/health
Database: ${DB_NAME}
    `);
  });
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  if (client) await client.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\nShutting down...');
  if (client) await client.close();
  process.exit(0);
});

start();
