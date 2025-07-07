const express = require('express');
const multer = require('multer');
const { authenticate } = require('../middleware/auth');
const { uploadFile } = require('../config/cloudinary');
const db = require('../db');

const router = express.Router();

// Configure multer for file uploads
const upload = multer({ dest: 'uploads/' });

// Get all posts - update the query to include profile image
router.get('/posts', authenticate, async (req, res) => {
  try {
    let query = `
      SELECT p.*, u.username, u.profile_image, 
        (SELECT COUNT(*) FROM comments WHERE post_id = p.id) as comment_count,
        e.entity_type as linked_type, e.entity_id as linked_id,
        c.title as class_title, c.id as class_id,
        m.title as module_title, m.id as module_id,
        a.title as assignment_title, a.id as assignment_id
      FROM posts p
      JOIN users u ON p.user_id = u.id
      LEFT JOIN posts_entities e ON p.id = e.posts_id
      LEFT JOIN classes c ON e.entity_type = 'class' AND e.entity_id = c.id
      LEFT JOIN modules m ON e.entity_type = 'module' AND e.entity_id = m.id
      LEFT JOIN assignments a ON e.entity_type = 'assignment' AND e.entity_id = a.id
      ORDER BY p.created_at DESC
    `;

    const result = await db.query(query);

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching posts:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get a post by ID with comments - update to include profile images
router.get('/posts/:id', authenticate, async (req, res) => {
  try {
    // Get post with entity information and profile image
    const postResult = await db.query(`
      SELECT p.*, u.username, u.profile_image,
        e.entity_type as linked_type, e.entity_id as linked_id,
        c.title as class_title, c.id as class_id,
        m.title as module_title, m.id as module_id,
        a.title as assignment_title, a.id as assignment_id
      FROM posts p
      JOIN users u ON p.user_id = u.id
      LEFT JOIN posts_entities e ON p.id = e.posts_id
      LEFT JOIN classes c ON e.entity_type = 'class' AND e.entity_id = c.id
      LEFT JOIN modules m ON e.entity_type = 'module' AND e.entity_id = m.id
      LEFT JOIN assignments a ON e.entity_type = 'assignment' AND e.entity_id = a.id
      WHERE p.id = $1
    `, [req.params.id]);

    if (postResult.rows.length === 0) {
      return res.status(404).json({ message: 'Post not found' });
    }

    // Get comments with profile images
    const commentsResult = await db.query(`
      SELECT c.*, u.username, u.profile_image
      FROM comments c
      JOIN users u ON c.user_id = u.id
      WHERE c.post_id = $1
      ORDER BY c.created_at ASC
    `, [req.params.id]);

    const post = postResult.rows[0];
    post.comments = commentsResult.rows;

    res.json(post);
  } catch (error) {
    console.error('Error fetching post:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get posts for a specific linked entity (class, module, or assignment)
router.get('/posts/for/:type/:id', async (req, res) => {
  try {
    const { type, id } = req.params;
    
    if (!['class', 'module', 'assignment'].includes(type)) {
      return res.status(400).json({ message: 'Invalid entity type' });
    }

    const result = await db.query(`
      SELECT p.*, u.username,
        (SELECT COUNT(*) FROM comments WHERE post_id = p.id) as comment_count,
        e.entity_type as linked_type, e.entity_id as linked_id
      FROM posts p
      JOIN users u ON p.user_id = u.id
      JOIN posts_entities e ON p.id = e.posts_id
      WHERE e.entity_type = $1 AND e.entity_id = $2
      ORDER BY p.created_at DESC
    `, [type, id]);

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching linked posts:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Create a new post
router.post('/posts', authenticate, upload.single('image'), async (req, res) => {
  try {
    const { content, entityType, entityId } = req.body;
    const file = req.file;

    if (!content) {
      return res.status(400).json({ message: 'Content is required' });
    }

    // Validate entity type if provided
    if (entityType && !['class', 'module', 'assignment'].includes(entityType)) {
      return res.status(400).json({ message: 'Invalid entity type' });
    }

    // If entityType is provided, verify that the linked entity exists
    if (entityType && entityId) {
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
    }

    let imageUrl = null;
    if (file) {
      const uploadResult = await uploadFile(file, 'posts');
      imageUrl = uploadResult.url;
    }

    // Start a transaction
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');

      const result = await client.query(
        'INSERT INTO posts (user_id, content, image_url) VALUES ($1, $2, $3) RETURNING *',
        [req.user.id, content, imageUrl]
      );

      const post = result.rows[0];

      // If entity provided, create the link
      if (entityType && entityId) {
        await client.query(
          'INSERT INTO posts_entities (posts_id, entity_type, entity_id) VALUES ($1, $2, $3)',
          [post.id, entityType, entityId]
        );
      }

      await client.query('COMMIT');

      // Get username and profile image for response
      const userResult = await db.query('SELECT username, profile_image FROM users WHERE id = $1', [req.user.id]);
      post.username = userResult.rows[0].username;
      post.profile_image = userResult.rows[0].profile_image;
      post.comment_count = 0;

      // Get linked entity details if applicable
      if (entityType && entityId) {
        post.linked_type = entityType;
        post.linked_id = parseInt(entityId);

        let entityDetails;
        switch (entityType) {
          case 'class':
            entityDetails = await db.query('SELECT title FROM classes WHERE id = $1', [entityId]);
            if (entityDetails.rows.length > 0) {
              post.class_title = entityDetails.rows[0].title;
              post.class_id = parseInt(entityId);
            }
            break;
          case 'module':
            entityDetails = await db.query('SELECT title FROM modules WHERE id = $1', [entityId]);
            if (entityDetails.rows.length > 0) {
              post.module_title = entityDetails.rows[0].title;
              post.module_id = parseInt(entityId);
            }
            break;
          case 'assignment':
            entityDetails = await db.query('SELECT title FROM assignments WHERE id = $1', [entityId]);
            if (entityDetails.rows.length > 0) {
              post.assignment_title = entityDetails.rows[0].title;
              post.assignment_id = parseInt(entityId);
            }
            break;
        }
      }

      res.status(201).json(post);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error creating post:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Update a post
router.put('/posts/:id', authenticate, upload.single('image'), async (req, res) => {
  try {
    const { content, entityType, entityId } = req.body;
    const file = req.file;

    if (!content) {
      return res.status(400).json({ message: 'Content is required' });
    }

    // Validate entity type if provided
    if (entityType && !['class', 'module', 'assignment'].includes(entityType)) {
      return res.status(400).json({ message: 'Invalid entity type' });
    }

    // Check if post exists and user is the creator
    const postCheck = await db.query(
      'SELECT * FROM posts WHERE id = $1',
      [req.params.id]
    );

    if (postCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Post not found' });
    }

    if (postCheck.rows[0].user_id !== req.user.id) {
      return res.status(403).json({ message: 'Not authorized to update this post' });
    }

    // If entityType is provided, verify that the linked entity exists
    if (entityType && entityId) {
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
    }

    let imageUrl = postCheck.rows[0].image_url;
    if (file) {
      const uploadResult = await uploadFile(file, 'posts');
      imageUrl = uploadResult.url;
    }

    // Start a transaction
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');

      // Update post
      const result = await client.query(
        'UPDATE posts SET content = $1, image_url = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3 RETURNING *',
        [content, imageUrl, req.params.id]
      );

      // Update entity link if provided
      if (entityType && entityId) {
        // Check if link already exists
        const linkCheck = await client.query(
          'SELECT * FROM posts_entities WHERE posts_id = $1',
          [req.params.id]
        );

        if (linkCheck.rows.length > 0) {
          // Update existing link
          await client.query(
            'UPDATE posts_entities SET entity_type = $1, entity_id = $2 WHERE posts_id = $3',
            [entityType, entityId, req.params.id]
          );
        } else {
          // Create new link
          await client.query(
            'INSERT INTO posts_entities (posts_id, entity_type, entity_id) VALUES ($1, $2, $3)',
            [req.params.id, entityType, entityId]
          );
        }
      } else {
        // Remove any existing links if no link is provided
        await client.query('DELETE FROM posts_entities WHERE posts_id = $1', [req.params.id]);
      }

      await client.query('COMMIT');

      // Get complete post with entity information
      const completePostResult = await db.query(`
        SELECT p.*, u.username, u.profile_image,
               e.entity_type as linked_type, e.entity_id as linked_id,
               c.title as class_title, c.id as class_id,
               m.title as module_title, m.id as module_id,
               a.title as assignment_title, a.id as assignment_id
        FROM posts p
        JOIN users u ON p.user_id = u.id
        LEFT JOIN posts_entities e ON p.id = e.posts_id
        LEFT JOIN classes c ON e.entity_type = 'class' AND e.entity_id = c.id
        LEFT JOIN modules m ON e.entity_type = 'module' AND e.entity_id = m.id
        LEFT JOIN assignments a ON e.entity_type = 'assignment' AND e.entity_id = a.id
        WHERE p.id = $1
      `, [req.params.id]);

      res.json(completePostResult.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error updating post:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Add entity link to post
router.post('/posts/:id/link/:entityType/:entityId', authenticate, async (req, res) => {
  try {
    const { id, entityType, entityId } = req.params;
    
    // Verify post exists
    const postCheck = await db.query('SELECT * FROM posts WHERE id = $1', [id]);
    if (postCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Post not found' });
    }

    // Only allow the creator to update links
    if (postCheck.rows[0].user_id !== req.user.id) {
      return res.status(403).json({ message: 'Not authorized to update this post' });
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
      'SELECT * FROM posts_entities WHERE posts_id = $1',
      [id]
    );

    if (linkCheck.rows.length > 0) {
      // Update existing link
      await db.query(
        'UPDATE posts_entities SET entity_type = $1, entity_id = $2 WHERE posts_id = $3',
        [entityType, entityId, id]
      );
    } else {
      // Create new link
      await db.query(
        'INSERT INTO posts_entities (posts_id, entity_type, entity_id) VALUES ($1, $2, $3)',
        [id, entityType, entityId]
      );
    }

    res.json({ message: 'Entity linked successfully' });
  } catch (error) {
    console.error('Error linking entity:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Remove entity link from post
router.delete('/posts/:id/unlink', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Verify post exists
    const postCheck = await db.query('SELECT * FROM posts WHERE id = $1', [id]);
    if (postCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Post not found' });
    }

    // Only allow the creator to remove links
    if (postCheck.rows[0].user_id !== req.user.id) {
      return res.status(403).json({ message: 'Not authorized to update this post' });
    }

    // Remove the link
    await db.query('DELETE FROM posts_entities WHERE posts_id = $1', [id]);

    res.json({ message: 'Entity link removed successfully' });
  } catch (error) {
    console.error('Error removing entity link:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Delete a post
router.delete('/posts/:id', authenticate, async (req, res) => {
  try {
    // Check if post exists and user is the creator
    const postCheck = await db.query(
      'SELECT * FROM posts WHERE id = $1',
      [req.params.id]
    );

    if (postCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Post not found' });
    }

    if (postCheck.rows[0].user_id !== req.user.id) {
      return res.status(403).json({ message: 'Not authorized to delete this post' });
    }

    await db.query('DELETE FROM posts WHERE id = $1', [req.params.id]);

    res.json({ message: 'Post deleted successfully' });
  } catch (error) {
    console.error('Error deleting post:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Add a comment to a post
router.post('/posts/:id/comments', authenticate, async (req, res) => {
  try {
    const { content } = req.body;

    if (!content) {
      return res.status(400).json({ message: 'Content is required' });
    }

    // Check if post exists
    const postCheck = await db.query('SELECT * FROM posts WHERE id = $1', [req.params.id]);
    if (postCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Post not found' });
    }

    const result = await db.query(
      'INSERT INTO comments (post_id, user_id, content) VALUES ($1, $2, $3) RETURNING *',
      [req.params.id, req.user.id, content]
    );

    // Get username and profile image for response
    const userResult = await db.query('SELECT username, profile_image FROM users WHERE id = $1', [req.user.id]);
    const comment = result.rows[0];
    comment.username = userResult.rows[0].username;
    comment.profile_image = userResult.rows[0].profile_image;

    res.status(201).json(comment);
  } catch (error) {
    console.error('Error creating comment:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Delete a comment
router.delete('/comments/:id', authenticate, async (req, res) => {
  try {
    // Check if comment exists and user is the creator
    const commentCheck = await db.query(
      'SELECT * FROM comments WHERE id = $1',
      [req.params.id]
    );

    if (commentCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Comment not found' });
    }

    if (commentCheck.rows[0].user_id !== req.user.id) {
      return res.status(403).json({ message: 'Not authorized to delete this comment' });
    }

    await db.query('DELETE FROM comments WHERE id = $1', [req.params.id]);

    res.json({ message: 'Comment deleted successfully' });
  } catch (error) {
    console.error('Error deleting comment:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
