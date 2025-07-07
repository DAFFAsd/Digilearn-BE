const express = require('express');
const { authenticate, authorize } = require('../middleware/auth');
const db = require('../db');

const router = express.Router();

// Get all folders for a class
router.get('/class/:classId', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT f.*, u.username as creator_name,
        (SELECT COUNT(*) FROM modules WHERE folder_id = f.id) as module_count
      FROM module_folders f
      JOIN users u ON f.created_by = u.id
      WHERE f.class_id = $1
      ORDER BY f.order_index ASC, f.created_at ASC
    `, [req.params.classId]);

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching folders:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get a folder by ID
router.get('/:id', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT f.*, u.username as creator_name, c.title as class_title
      FROM module_folders f
      JOIN users u ON f.created_by = u.id
      JOIN classes c ON f.class_id = c.id
      WHERE f.id = $1
    `, [req.params.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Folder not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching folder:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Create a new folder (aslab only)
router.post('/', authenticate, authorize(['aslab']), async (req, res) => {
  try {
    const { class_id, title, order_index = 0 } = req.body;

    if (!class_id || !title) {
      return res.status(400).json({ message: 'Class ID and title are required' });
    }

    // Check if class exists
    const classCheck = await db.query('SELECT * FROM classes WHERE id = $1', [class_id]);
    if (classCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Class not found' });
    }

    const result = await db.query(
      'INSERT INTO module_folders (class_id, title, order_index, created_by) VALUES ($1, $2, $3, $4) RETURNING *',
      [class_id, title, order_index, req.user.id]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error creating folder:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Update a folder (aslab only)
router.put('/:id', authenticate, authorize(['aslab']), async (req, res) => {
  try {
    const { title, order_index } = req.body;

    if (!title) {
      return res.status(400).json({ message: 'Title is required' });
    }

    // Check if folder exists
    const folderCheck = await db.query('SELECT * FROM module_folders WHERE id = $1', [req.params.id]);
    if (folderCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Folder not found' });
    }

    // Only allow the creator or an aslab to update
    if (folderCheck.rows[0].created_by !== req.user.id && req.user.role !== 'aslab') {
      return res.status(403).json({ message: 'Not authorized to update this folder' });
    }

    const result = await db.query(
      'UPDATE module_folders SET title = $1, order_index = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3 RETURNING *',
      [title, order_index || folderCheck.rows[0].order_index, req.params.id]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating folder:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Delete a folder (aslab only)
router.delete('/:id', authenticate, authorize(['aslab']), async (req, res) => {
  try {
    // Check if folder exists
    const folderCheck = await db.query('SELECT * FROM module_folders WHERE id = $1', [req.params.id]);
    if (folderCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Folder not found' });
    }

    // Only allow the creator or an aslab to delete
    if (folderCheck.rows[0].created_by !== req.user.id && req.user.role !== 'aslab') {
      return res.status(403).json({ message: 'Not authorized to delete this folder' });
    }

    await db.query('DELETE FROM module_folders WHERE id = $1', [req.params.id]);

    res.json({ message: 'Folder deleted successfully' });
  } catch (error) {
    console.error('Error deleting folder:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
