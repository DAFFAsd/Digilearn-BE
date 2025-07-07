const express = require('express');
const multer = require('multer');
const { authenticate, authorize } = require('../middleware/auth');
const { uploadFile } = require('../config/cloudinary');
const db = require('../db');

const router = express.Router();

// Configure multer for file uploads
const upload = multer({ dest: 'uploads/' });

// Get all classes
router.get('/', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT c.*, u.username as creator_name
      FROM classes c
      JOIN users u ON c.created_by = u.id
      ORDER BY c.created_at DESC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching classes:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get a class by ID
router.get('/:id', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT c.*, u.username as creator_name
      FROM classes c
      JOIN users u ON c.created_by = u.id
      WHERE c.id = $1
    `, [req.params.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Class not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching class:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Create a new class (aslab only)
router.post('/', authenticate, authorize(['aslab']), upload.single('image'), async (req, res) => {
  try {
    const { title, description } = req.body;
    const file = req.file;

    if (!title) {
      return res.status(400).json({ message: 'Title is required' });
    }

    let imageUrl = null;
    if (file) {
      const uploadResult = await uploadFile(file, 'classes');
      imageUrl = uploadResult.url;
    }

    const result = await db.query(
      'INSERT INTO classes (title, description, image_url, created_by) VALUES ($1, $2, $3, $4) RETURNING *',
      [title, description, imageUrl, req.user.id]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error creating class:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Update a class (aslab only)
router.put('/:id', authenticate, authorize(['aslab']), upload.single('image'), async (req, res) => {
  try {
    const { title, description } = req.body;
    const file = req.file;

    if (!title) {
      return res.status(400).json({ message: 'Title is required' });
    }

    // Check if class exists and user is the creator
    const classCheck = await db.query(
      'SELECT * FROM classes WHERE id = $1',
      [req.params.id]
    );

    if (classCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Class not found' });
    }

    // Only allow the creator or an aslab to update
    if (classCheck.rows[0].created_by !== req.user.id && req.user.role !== 'aslab') {
      return res.status(403).json({ message: 'Not authorized to update this class' });
    }

    let imageUrl = classCheck.rows[0].image_url;
    if (file) {
      const uploadResult = await uploadFile(file, 'classes');
      imageUrl = uploadResult.url;
    }

    const result = await db.query(
      'UPDATE classes SET title = $1, description = $2, image_url = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $4 RETURNING *',
      [title, description, imageUrl, req.params.id]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating class:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Delete a class (aslab only)
router.delete('/:id', authenticate, authorize(['aslab']), async (req, res) => {
  try {
    // Check if class exists and user is the creator
    const classCheck = await db.query(
      'SELECT * FROM classes WHERE id = $1',
      [req.params.id]
    );

    if (classCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Class not found' });
    }

    // Only allow the creator or an aslab to delete
    if (classCheck.rows[0].created_by !== req.user.id && req.user.role !== 'aslab') {
      return res.status(403).json({ message: 'Not authorized to delete this class' });
    }

    await db.query('DELETE FROM classes WHERE id = $1', [req.params.id]);

    res.json({ message: 'Class deleted successfully' });
  } catch (error) {
    console.error('Error deleting class:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Enroll in a class (praktikan only)
router.post('/:id/enroll', authenticate, authorize(['praktikan']), async (req, res) => {
  try {
    // Check if class exists
    const classCheck = await db.query(
      'SELECT * FROM classes WHERE id = $1',
      [req.params.id]
    );

    if (classCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Class not found' });
    }

    // Check if already enrolled
    const enrollmentCheck = await db.query(
      'SELECT * FROM class_enrollments WHERE class_id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );

    if (enrollmentCheck.rows.length > 0) {
      return res.status(400).json({ message: 'Already enrolled in this class' });
    }

    // Create enrollment
    await db.query(
      'INSERT INTO class_enrollments (class_id, user_id) VALUES ($1, $2)',
      [req.params.id, req.user.id]
    );

    res.status(201).json({ message: 'Enrolled successfully' });
  } catch (error) {
    console.error('Error enrolling in class:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get enrolled classes for current user
router.get('/enrolled/me', authenticate, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT c.*, u.username as creator_name, e.enrolled_at
      FROM classes c
      JOIN users u ON c.created_by = u.id
      JOIN class_enrollments e ON c.id = e.class_id
      WHERE e.user_id = $1
      ORDER BY e.enrolled_at DESC
    `, [req.user.id]);

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching enrolled classes:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
