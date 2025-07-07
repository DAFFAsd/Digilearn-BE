const express = require('express');
const multer = require('multer');
const { authenticate, authorize } = require('../middleware/auth');
const { uploadFile } = require('../config/cloudinary');
const db = require('../db');

const router = express.Router();

// Configure multer for file uploads
const upload = multer({ dest: 'uploads/' });

// Get all news
router.get('/', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT n.*, u.username as author, 
             e.entity_type as linked_type, e.entity_id as linked_id,
             c.title as class_title, c.id as class_id,
             m.title as module_title, m.id as module_id,
             a.title as assignment_title, a.id as assignment_id
      FROM news n
      JOIN users u ON n.created_by = u.id
      LEFT JOIN news_entities e ON n.id = e.news_id
      LEFT JOIN classes c ON e.entity_type = 'class' AND e.entity_id = c.id
      LEFT JOIN modules m ON e.entity_type = 'module' AND e.entity_id = m.id
      LEFT JOIN assignments a ON e.entity_type = 'assignment' AND e.entity_id = a.id
      ORDER BY n.created_at DESC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching news:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get a news item by ID
router.get('/:id', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT n.*, u.username as author,
             e.entity_type as linked_type, e.entity_id as linked_id,
             c.title as class_title, c.id as class_id,
             m.title as module_title, m.id as module_id,
             a.title as assignment_title, a.id as assignment_id
      FROM news n
      JOIN users u ON n.created_by = u.id
      LEFT JOIN news_entities e ON n.id = e.news_id
      LEFT JOIN classes c ON e.entity_type = 'class' AND e.entity_id = c.id
      LEFT JOIN modules m ON e.entity_type = 'module' AND e.entity_id = m.id
      LEFT JOIN assignments a ON e.entity_type = 'assignment' AND e.entity_id = a.id
      WHERE n.id = $1
    `, [req.params.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'News not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching news:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get news for a specific linked entity (class, module, or assignment)
router.get('/for/:type/:id', async (req, res) => {
  try {
    const { type, id } = req.params;
    
    if (!['class', 'module', 'assignment'].includes(type)) {
      return res.status(400).json({ message: 'Invalid entity type' });
    }

    const result = await db.query(`
      SELECT n.*, u.username as author,
             e.entity_type as linked_type, e.entity_id as linked_id
      FROM news n
      JOIN users u ON n.created_by = u.id
      JOIN news_entities e ON n.id = e.news_id
      WHERE e.entity_type = $1 AND e.entity_id = $2
      ORDER BY n.created_at DESC
    `, [type, id]);

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching linked news:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// New endpoint: Get news with entity information using joined table
router.get('/with-entity', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT n.*, u.username as author, 
             e.entity_type, e.entity_id,
             c.title as class_title,
             m.title as module_title,
             a.title as assignment_title
      FROM news n
      JOIN users u ON n.created_by = u.id
      LEFT JOIN news_entities e ON n.id = e.news_id
      LEFT JOIN classes c ON e.entity_type = 'class' AND e.entity_id = c.id
      LEFT JOIN modules m ON e.entity_type = 'module' AND e.entity_id = m.id
      LEFT JOIN assignments a ON e.entity_type = 'assignment' AND e.entity_id = a.id
      ORDER BY n.created_at DESC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching news with entities:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Add entity link to news
router.post('/:id/link/:entityType/:entityId', authenticate, authorize(['aslab']), async (req, res) => {
  try {
    const { id, entityType, entityId } = req.params;
    
    // Verify news exists
    const newsCheck = await db.query('SELECT * FROM news WHERE id = $1', [id]);
    if (newsCheck.rows.length === 0) {
      return res.status(404).json({ message: 'News not found' });
    }

    // Only allow the creator or an aslab to update links
    if (newsCheck.rows[0].created_by !== req.user.id && req.user.role !== 'aslab') {
      return res.status(403).json({ message: 'Not authorized to update this news' });
    }
    
    // Validate entity type
    if (!['class', 'module', 'assignment'].includes(entityType)) {
      return res.status(400).json({ message: 'Invalid entity type' });
    }

    // Verify entity exists
    let entityExists = false;
    switch(entityType) {
      case 'class':
        const classCheck = await db.query('SELECT id FROM classes WHERE id = $1', [entityId]);
        entityExists = classCheck.rows.length > 0;
        break;
      case 'module':
        const moduleCheck = await db.query('SELECT id FROM modules WHERE id = $1', [entityId]);
        entityExists = moduleCheck.rows.length > 0;
        break;
      case 'assignment':
        const assignmentCheck = await db.query('SELECT id FROM assignments WHERE id = $1', [entityId]);
        entityExists = assignmentCheck.rows.length > 0;
        break;
    }

    if (!entityExists) {
      return res.status(404).json({ message: `${entityType.charAt(0).toUpperCase() + entityType.slice(1)} not found` });
    }

    // Check if link already exists
    const linkCheck = await db.query(
      'SELECT * FROM news_entities WHERE news_id = $1',
      [id]
    );

    if (linkCheck.rows.length > 0) {
      // Update existing link
      await db.query(
        'UPDATE news_entities SET entity_type = $1, entity_id = $2 WHERE news_id = $3',
        [entityType, entityId, id]
      );
    } else {
      // Create new link
      await db.query(
        'INSERT INTO news_entities (news_id, entity_type, entity_id) VALUES ($1, $2, $3)',
        [id, entityType, entityId]
      );
    }

    res.json({ message: 'Entity linked successfully' });
  } catch (error) {
    console.error('Error linking entity:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Remove entity link from news
router.delete('/:id/unlink', authenticate, authorize(['aslab']), async (req, res) => {
  try {
    const { id } = req.params;
    
    // Verify news exists
    const newsCheck = await db.query('SELECT * FROM news WHERE id = $1', [id]);
    if (newsCheck.rows.length === 0) {
      return res.status(404).json({ message: 'News not found' });
    }

    // Only allow the creator or an aslab to remove links
    if (newsCheck.rows[0].created_by !== req.user.id && req.user.role !== 'aslab') {
      return res.status(403).json({ message: 'Not authorized to update this news' });
    }

    // Remove the link
    await db.query('DELETE FROM news_entities WHERE news_id = $1', [id]);

    res.json({ message: 'Entity link removed successfully' });
  } catch (error) {
    console.error('Error removing entity link:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get all news related to an entity
router.get('/entity/:entityType/:entityId', async (req, res) => {
  try {
    const { entityType, entityId } = req.params;
    
    // Validate entity type
    if (!['class', 'module', 'assignment'].includes(entityType)) {
      return res.status(400).json({ message: 'Invalid entity type' });
    }

    const result = await db.query(`
      SELECT n.*, u.username as author
      FROM news n
      JOIN users u ON n.created_by = u.id
      JOIN news_entities e ON n.id = e.news_id
      WHERE e.entity_type = $1 AND e.entity_id = $2
      ORDER BY n.created_at DESC
    `, [entityType, entityId]);

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching entity news:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Create a news item (aslab only)
router.post('/', authenticate, authorize(['aslab']), upload.single('image'), async (req, res) => {
  try {
    const { title, content, linkedType, linkedId } = req.body;
    const file = req.file;

    if (!title || !content) {
      return res.status(400).json({ message: 'Title and content are required' });
    }

    // Validate linked entity if provided
    if (linkedType && !['class', 'module', 'assignment'].includes(linkedType)) {
      return res.status(400).json({ message: 'Invalid linked entity type' });
    }

    // If linkedType is provided, verify that the linked entity exists
    if (linkedType && linkedId) {
      let entityExists = false;
      switch(linkedType) {
        case 'class':
          const classCheck = await db.query('SELECT id FROM classes WHERE id = $1', [linkedId]);
          entityExists = classCheck.rows.length > 0;
          break;
        case 'module':
          const moduleCheck = await db.query('SELECT id FROM modules WHERE id = $1', [linkedId]);
          entityExists = moduleCheck.rows.length > 0;
          break;
        case 'assignment':
          const assignmentCheck = await db.query('SELECT id FROM assignments WHERE id = $1', [linkedId]);
          entityExists = assignmentCheck.rows.length > 0;
          break;
      }

      if (!entityExists) {
        return res.status(404).json({ message: `${linkedType.charAt(0).toUpperCase() + linkedType.slice(1)} not found` });
      }
    }

    let imageUrl = null;
    if (file) {
      const uploadResult = await uploadFile(file, 'news');
      imageUrl = uploadResult.url;
    }

    // Start a transaction
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');

      // Create news
      const newsResult = await client.query(
        'INSERT INTO news (title, content, image_url, created_by) VALUES ($1, $2, $3, $4) RETURNING *',
        [title, content, imageUrl, req.user.id]
      );

      const news = newsResult.rows[0];

      // If linked entity provided, create the link
      if (linkedType && linkedId) {
        await client.query(
          'INSERT INTO news_entities (news_id, entity_type, entity_id) VALUES ($1, $2, $3)',
          [news.id, linkedType, linkedId]
        );
      }

      await client.query('COMMIT');

      // Get username for response
      const userResult = await db.query('SELECT username FROM users WHERE id = $1', [req.user.id]);
      news.author = userResult.rows[0].username;

      // Get linked entity details if applicable
      if (linkedType && linkedId) {
        news.linked_type = linkedType;
        news.linked_id = parseInt(linkedId);

        let entityDetails;
        switch (linkedType) {
          case 'class':
            entityDetails = await db.query('SELECT title FROM classes WHERE id = $1', [linkedId]);
            if (entityDetails.rows.length > 0) {
              news.class_title = entityDetails.rows[0].title;
              news.class_id = parseInt(linkedId);
            }
            break;
          case 'module':
            entityDetails = await db.query('SELECT title FROM modules WHERE id = $1', [linkedId]);
            if (entityDetails.rows.length > 0) {
              news.module_title = entityDetails.rows[0].title;
              news.module_id = parseInt(linkedId);
            }
            break;
          case 'assignment':
            entityDetails = await db.query('SELECT title FROM assignments WHERE id = $1', [linkedId]);
            if (entityDetails.rows.length > 0) {
              news.assignment_title = entityDetails.rows[0].title;
              news.assignment_id = parseInt(linkedId);
            }
            break;
        }
      }

      res.status(201).json(news);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error creating news:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Update a news item (aslab only)
router.put('/:id', authenticate, authorize(['aslab']), upload.single('image'), async (req, res) => {
  try {
    const { title, content, linkedType, linkedId } = req.body;
    const file = req.file;

    if (!title || !content) {
      return res.status(400).json({ message: 'Title and content are required' });
    }

    // Validate linked entity if provided
    if (linkedType && !['class', 'module', 'assignment'].includes(linkedType)) {
      return res.status(400).json({ message: 'Invalid linked entity type' });
    }

    // Check if news exists
    const newsCheck = await db.query('SELECT * FROM news WHERE id = $1', [req.params.id]);
    if (newsCheck.rows.length === 0) {
      return res.status(404).json({ message: 'News not found' });
    }

    // Only allow the creator or an aslab to update
    if (newsCheck.rows[0].created_by !== req.user.id && req.user.role !== 'aslab') {
      return res.status(403).json({ message: 'Not authorized to update this news' });
    }

    // If linkedType is provided, verify that the linked entity exists
    if (linkedType && linkedId) {
      let entityExists = false;
      switch(linkedType) {
        case 'class':
          const classCheck = await db.query('SELECT id FROM classes WHERE id = $1', [linkedId]);
          entityExists = classCheck.rows.length > 0;
          break;
        case 'module':
          const moduleCheck = await db.query('SELECT id FROM modules WHERE id = $1', [linkedId]);
          entityExists = moduleCheck.rows.length > 0;
          break;
        case 'assignment':
          const assignmentCheck = await db.query('SELECT id FROM assignments WHERE id = $1', [linkedId]);
          entityExists = assignmentCheck.rows.length > 0;
          break;
      }

      if (!entityExists) {
        return res.status(404).json({ message: `${linkedType.charAt(0).toUpperCase() + linkedType.slice(1)} not found` });
      }
    }

    let imageUrl = newsCheck.rows[0].image_url;
    if (file) {
      const uploadResult = await uploadFile(file, 'news');
      imageUrl = uploadResult.url;
    }

    // Start a transaction
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');

      // Update news
      const newsResult = await client.query(
        'UPDATE news SET title = $1, content = $2, image_url = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $4 RETURNING *',
        [title, content, imageUrl, req.params.id]
      );

      // Update entity link if provided
      if (linkedType && linkedId) {
        // Check if link already exists
        const linkCheck = await client.query(
          'SELECT * FROM news_entities WHERE news_id = $1',
          [req.params.id]
        );

        if (linkCheck.rows.length > 0) {
          // Update existing link
          await client.query(
            'UPDATE news_entities SET entity_type = $1, entity_id = $2 WHERE news_id = $3',
            [linkedType, linkedId, req.params.id]
          );
        } else {
          // Create new link
          await client.query(
            'INSERT INTO news_entities (news_id, entity_type, entity_id) VALUES ($1, $2, $3)',
            [req.params.id, linkedType, linkedId]
          );
        }
      } else {
        // Remove any existing links if no link is provided
        await client.query('DELETE FROM news_entities WHERE news_id = $1', [req.params.id]);
      }

      await client.query('COMMIT');

      // Get complete news with entity information
      const completeNewsResult = await db.query(`
        SELECT n.*, u.username as author,
               e.entity_type as linked_type, e.entity_id as linked_id,
               c.title as class_title, c.id as class_id,
               m.title as module_title, m.id as module_id,
               a.title as assignment_title, a.id as assignment_id
        FROM news n
        JOIN users u ON n.created_by = u.id
        LEFT JOIN news_entities e ON n.id = e.news_id
        LEFT JOIN classes c ON e.entity_type = 'class' AND e.entity_id = c.id
        LEFT JOIN modules m ON e.entity_type = 'module' AND e.entity_id = m.id
        LEFT JOIN assignments a ON e.entity_type = 'assignment' AND e.entity_id = a.id
        WHERE n.id = $1
      `, [req.params.id]);

      res.json(completeNewsResult.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error updating news:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Delete a news item (aslab only)
router.delete('/:id', authenticate, authorize(['aslab']), async (req, res) => {
  try {
    // Check if news exists
    const newsCheck = await db.query('SELECT * FROM news WHERE id = $1', [req.params.id]);
    if (newsCheck.rows.length === 0) {
      return res.status(404).json({ message: 'News not found' });
    }

    // Only allow the creator or an aslab to delete
    if (newsCheck.rows[0].created_by !== req.user.id && req.user.role !== 'aslab') {
      return res.status(403).json({ message: 'Not authorized to delete this news' });
    }

    await db.query('DELETE FROM news WHERE id = $1', [req.params.id]);

    res.json({ message: 'News deleted successfully' });
  } catch (error) {
    console.error('Error deleting news:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
