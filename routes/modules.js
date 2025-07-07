const express = require('express');
const multer = require('multer');
const { authenticate, authorize } = require('../middleware/auth');
const { uploadFile, fixFileAccess } = require('../config/cloudinary');
const db = require('../db');

const router = express.Router();

// Configure multer for file uploads
const upload = multer({ dest: 'uploads/' });

// Maximum number of files allowed per upload
const MAX_FILES = 5;

// Get all modules for a class
router.get('/class/:classId', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT m.*, u.username as creator_name, f.title as folder_title
      FROM modules m
      JOIN users u ON m.created_by = u.id
      LEFT JOIN module_folders f ON m.folder_id = f.id
      WHERE m.class_id = $1
      ORDER BY m.order_index ASC, m.created_at ASC
    `, [req.params.classId]);

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching modules:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get all modules for a folder
router.get('/folder/:folderId', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT m.*, u.username as creator_name
      FROM modules m
      JOIN users u ON m.created_by = u.id
      WHERE m.folder_id = $1
      ORDER BY m.order_index ASC, m.created_at ASC
    `, [req.params.folderId]);

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching modules in folder:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get a module by ID
router.get('/:id', async (req, res) => {
  try {
    // Get module details
    const moduleResult = await db.query(`
      SELECT m.*, u.username as creator_name, c.title as class_title, f.title as folder_title
      FROM modules m
      JOIN users u ON m.created_by = u.id
      JOIN classes c ON m.class_id = c.id
      LEFT JOIN module_folders f ON m.folder_id = f.id
      WHERE m.id = $1
    `, [req.params.id]);

    if (moduleResult.rows.length === 0) {
      return res.status(404).json({ message: 'Module not found' });
    }

    // Get module files
    const filesResult = await db.query(`
      SELECT * FROM module_files
      WHERE module_id = $1
      ORDER BY created_at DESC
    `, [req.params.id]);

    const module = moduleResult.rows[0];
    module.files = filesResult.rows;

    res.json(module);
  } catch (error) {
    console.error('Error fetching module:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Create a new module (aslab only)
router.post('/', authenticate, authorize(['aslab']), upload.array('files', MAX_FILES), async (req, res) => {
  try {
    const { class_id, folder_id, title, content, order_index = 0 } = req.body;
    const files = req.files;

    if (!class_id || !title || !content) {
      return res.status(400).json({ message: 'Class ID, title, and content are required' });
    }

    // Check if class exists
    const classCheck = await db.query('SELECT * FROM classes WHERE id = $1', [class_id]);
    if (classCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Class not found' });
    }

    // Check if folder exists if folder_id is provided
    if (folder_id) {
      const folderCheck = await db.query('SELECT * FROM module_folders WHERE id = $1', [folder_id]);
      if (folderCheck.rows.length === 0) {
        return res.status(404).json({ message: 'Folder not found' });
      }
    }

    // Check if file count exceeds the maximum limit
    if (files && files.length > MAX_FILES) {
      return res.status(400).json({
        message: `Cannot add ${files.length} files. Maximum ${MAX_FILES} files allowed per module.`
      });
    }

    // Start a transaction
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');

      // Create module
      const moduleResult = await client.query(
        'INSERT INTO modules (class_id, folder_id, title, content, order_index, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
        [class_id, folder_id || null, title, content, order_index, req.user.id]
      );

      const module = moduleResult.rows[0];

      // Upload files if any
      if (files && files.length > 0) {
        for (const file of files) {
          const uploadResult = await uploadFile(file, 'module_files');

          await client.query(
            'INSERT INTO module_files (module_id, file_name, file_url, file_type, file_size, created_by) VALUES ($1, $2, $3, $4, $5, $6)',
            [module.id, file.originalname, uploadResult.url, file.mimetype, file.size, req.user.id]
          );
        }
      }

      await client.query('COMMIT');

      // Get the complete module with files
      const completeModuleResult = await db.query(`
        SELECT m.*, u.username as creator_name
        FROM modules m
        JOIN users u ON m.created_by = u.id
        WHERE m.id = $1
      `, [module.id]);

      const filesResult = await db.query('SELECT * FROM module_files WHERE module_id = $1', [module.id]);

      const completeModule = completeModuleResult.rows[0];
      completeModule.files = filesResult.rows;

      res.status(201).json(completeModule);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error creating module:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Update a module (aslab only)
router.put('/:id', authenticate, authorize(['aslab']), upload.array('files', MAX_FILES), async (req, res) => {
  try {
    const { title, content, folder_id, order_index } = req.body;
    const files = req.files;

    if (!title || !content) {
      return res.status(400).json({ message: 'Title and content are required' });
    }

    // Check if module exists
    const moduleCheck = await db.query('SELECT * FROM modules WHERE id = $1', [req.params.id]);
    if (moduleCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Module not found' });
    }

    // Only allow the creator or an aslab to update
    if (moduleCheck.rows[0].created_by !== req.user.id && req.user.role !== 'aslab') {
      return res.status(403).json({ message: 'Not authorized to update this module' });
    }

    // Check if folder exists if folder_id is provided
    if (folder_id) {
      const folderCheck = await db.query('SELECT * FROM module_folders WHERE id = $1', [folder_id]);
      if (folderCheck.rows.length === 0) {
        return res.status(404).json({ message: 'Folder not found' });
      }
    }

    // Check if adding new files would exceed the maximum limit
    if (files && files.length > 0) {
      // Get current file count
      const fileCountResult = await db.query('SELECT COUNT(*) FROM module_files WHERE module_id = $1', [req.params.id]);
      const currentFileCount = parseInt(fileCountResult.rows[0].count, 10);

      // Check if new files would exceed the limit
      if (currentFileCount + files.length > MAX_FILES) {
        return res.status(400).json({
          message: `Cannot add ${files.length} files. Maximum ${MAX_FILES} files allowed per module. Current count: ${currentFileCount}`
        });
      }
    }

    // Start a transaction
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');

      // Update module
      const moduleResult = await client.query(
        'UPDATE modules SET title = $1, content = $2, folder_id = $3, order_index = $4, updated_at = CURRENT_TIMESTAMP WHERE id = $5 RETURNING *',
        [
          title,
          content,
          folder_id || moduleCheck.rows[0].folder_id,
          order_index !== undefined ? order_index : moduleCheck.rows[0].order_index,
          req.params.id
        ]
      );

      // Upload new files if any
      if (files && files.length > 0) {
        for (const file of files) {
          const uploadResult = await uploadFile(file, 'module_files');

          await client.query(
            'INSERT INTO module_files (module_id, file_name, file_url, file_type, file_size, created_by) VALUES ($1, $2, $3, $4, $5, $6)',
            [req.params.id, file.originalname, uploadResult.url, file.mimetype, file.size, req.user.id]
          );
        }
      }

      await client.query('COMMIT');

      // Get the complete module with files
      const completeModuleResult = await db.query(`
        SELECT m.*, u.username as creator_name, c.title as class_title, f.title as folder_title
        FROM modules m
        JOIN users u ON m.created_by = u.id
        JOIN classes c ON m.class_id = c.id
        LEFT JOIN module_folders f ON m.folder_id = f.id
        WHERE m.id = $1
      `, [req.params.id]);

      const filesResult = await db.query('SELECT * FROM module_files WHERE module_id = $1', [req.params.id]);

      const completeModule = completeModuleResult.rows[0];
      completeModule.files = filesResult.rows;

      res.json(completeModule);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error updating module:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Delete a module (aslab only)
router.delete('/:id', authenticate, authorize(['aslab']), async (req, res) => {
  try {
    // Check if module exists
    const moduleCheck = await db.query('SELECT * FROM modules WHERE id = $1', [req.params.id]);
    if (moduleCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Module not found' });
    }

    // Only allow the creator or an aslab to delete
    if (moduleCheck.rows[0].created_by !== req.user.id && req.user.role !== 'aslab') {
      return res.status(403).json({ message: 'Not authorized to delete this module' });
    }

    // Files will be automatically deleted due to ON DELETE CASCADE
    await db.query('DELETE FROM modules WHERE id = $1', [req.params.id]);

    res.json({ message: 'Module deleted successfully' });
  } catch (error) {
    console.error('Error deleting module:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Delete a module file (aslab only)
router.delete('/files/:fileId', authenticate, authorize(['aslab']), async (req, res) => {
  try {
    // Check if file exists and get the module ID
    const fileCheck = await db.query(`
      SELECT f.*, m.created_by as module_creator
      FROM module_files f
      JOIN modules m ON f.module_id = m.id
      WHERE f.id = $1
    `, [req.params.fileId]);

    if (fileCheck.rows.length === 0) {
      return res.status(404).json({ message: 'File not found' });
    }

    const file = fileCheck.rows[0];

    // Only allow the module creator or an aslab to delete the file
    if (file.module_creator !== req.user.id && req.user.role !== 'aslab') {
      return res.status(403).json({ message: 'Not authorized to delete this file' });
    }

    await db.query('DELETE FROM module_files WHERE id = $1', [req.params.fileId]);

    res.json({ message: 'File deleted successfully' });
  } catch (error) {
    console.error('Error deleting file:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
