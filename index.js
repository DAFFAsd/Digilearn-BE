const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const dotenv = require('dotenv');
const path = require('path');
const { initializeDatabase } = require('./db');

// Import routes
const userRoutes = require('./routes/users');
const classRoutes = require('./routes/classes');
const moduleRoutes = require('./routes/modules');
const folderRoutes = require('./routes/folders');
const assignmentRoutes = require('./routes/assignments');
const socialRoutes = require('./routes/social');
const newsRoutes = require('./routes/news');
const downloadRoutes = require('./routes/downloads');
const uploadRoutes = require('./routes/uploads');

// Import database
const db = require('./db');

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors({
  origin: process.env.NODE_ENV === 'production' ? 'https://digilab-ng.com' : 'http://localhost:5173',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(cookieParser());

// Static uploads directory
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// API Routes
app.use('/api/users', userRoutes);
app.use('/api/classes', classRoutes);
app.use('/api/modules', moduleRoutes);
app.use('/api/folders', folderRoutes);
app.use('/api/assignments', assignmentRoutes);
app.use('/api/social', socialRoutes);
app.use('/api/news', newsRoutes);
app.use('/api/download', downloadRoutes);
app.use('/api/uploads', uploadRoutes);


// Get all subjects (legacy)
app.get('/api/subjects', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM modules ORDER BY created_at DESC');
    const subjects = result.rows.map(module => ({
      _id: module.id,
      title: module.title,
      content: module.content,
      createdAt: module.created_at,
      updatedAt: module.updated_at
    }));
    res.json(subjects);
  } catch (error) {
    console.error('Error fetching subjects:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get a subject by ID (legacy)
app.get('/api/subjects/:id', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM modules WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Subject not found' });
    }
    const module = result.rows[0];
    const subject = {
      _id: module.id,
      title: module.title,
      content: module.content,
      createdAt: module.created_at,
      updatedAt: module.updated_at
    };
    res.json(subject);
  } catch (error) {
    console.error('Error fetching subject:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Create a new subject (legacy)
app.post('/api/subjects', async (req, res) => {
  try {
    const { title, content } = req.body;
    if (!title || !content) {
      return res.status(400).json({ message: 'Title and content are required' });
    }

    const result = await db.query(
      'INSERT INTO modules (class_id, title, content, created_by) VALUES (1, $1, $2, 1) RETURNING *',
      [title, content]
    );

    const module = result.rows[0];
    res.status(201).json({
      _id: module.id,
      title: module.title,
      content: module.content,
      createdAt: module.created_at,
      updatedAt: module.updated_at
    });
  } catch (error) {
    console.error('Error creating subject:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Update a subject (legacy)
app.put('/api/subjects/:id', async (req, res) => {
  try {
    const { title, content } = req.body;
    if (!title || !content) {
      return res.status(400).json({ message: 'Title and content are required' });
    }

    const result = await db.query(
      'UPDATE modules SET title = $1, content = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3 RETURNING *',
      [title, content, req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Subject not found' });
    }

    const module = result.rows[0];
    res.json({
      _id: module.id,
      title: module.title,
      content: module.content,
      updatedAt: module.updated_at
    });
  } catch (error) {
    console.error('Error updating subject:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Delete a subject (legacy)
app.delete('/api/subjects/:id', async (req, res) => {
  try {
    const result = await db.query('DELETE FROM modules WHERE id = $1 RETURNING *', [req.params.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Subject not found' });
    }

    res.json({ message: 'Subject deleted successfully' });
  } catch (error) {
    console.error('Error deleting subject:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Health check route
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Digilab-NG API is running' });
});

// Run migrations (development only)
app.post('/api/run-migration', async (req, res) => {
  try {
    // Read the migration file
    const fs = require('fs');
    const path = require('path');
    const migrationPath = path.join(__dirname, 'migrations', 'create_grades_table.sql');
    const migrationSQL = fs.readFileSync(migrationPath, 'utf8');

    // Execute the migration
    await db.query(migrationSQL);

    res.json({ status: 'ok', message: 'Migration executed successfully' });
  } catch (error) {
    console.error('Error running migration:', error);
    res.status(500).json({ message: 'Error running migration', error: error.message });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ message: 'Something went wrong!' });
});

// Start server
async function startServer() {
  try {
    // Initialize database schema
    await initializeDatabase();

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Digilab-NG server running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Server startup error:', error);
    process.exit(1);
  }
}

startServer();
