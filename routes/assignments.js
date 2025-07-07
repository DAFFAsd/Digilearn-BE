const express = require('express');
const multer = require('multer');
const { authenticate, authorize } = require('../middleware/auth');
const { uploadFile } = require('../config/cloudinary');
const db = require('../db');

const router = express.Router();

// Configure multer for file uploads
const upload = multer({ dest: 'uploads/' });

// Maximum number of files allowed per upload
const MAX_FILES = 5;

// Get all assignments for a class
router.get('/class/:classId', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT a.*, u.username as creator_name
      FROM assignments a
      JOIN users u ON a.created_by = u.id
      WHERE a.class_id = $1
      ORDER BY a.deadline ASC
    `, [req.params.classId]);

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching assignments:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get upcoming assignments for the current user
router.get('/upcoming', authenticate, async (req, res) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit) : 5;
    console.log(`Fetching upcoming assignments for user ${req.user.id} with role ${req.user.role}`);

    // First check if the user is enrolled in any classes
    const enrollmentCheck = await db.query(
      'SELECT COUNT(*) FROM class_enrollments WHERE user_id = $1',
      [req.user.id]
    );

    const enrollmentCount = parseInt(enrollmentCheck.rows[0].count, 10);
    console.log(`User has ${enrollmentCount} class enrollments`);

    if (enrollmentCount === 0) {
      console.log('User is not enrolled in any classes, returning empty array');
      return res.json([]);
    }

    // Get assignments from classes the user is enrolled in
    // with deadlines in the future, ordered by closest deadline first
    // For praktikan, exclude assignments that have already been submitted
    let query = `
      SELECT a.*, c.title as class_title
      FROM assignments a
      JOIN classes c ON a.class_id = c.id
      JOIN class_enrollments e ON c.id = e.class_id
    `;

    if (req.user.role === 'praktikan') {
      // Add LEFT JOIN with submissions to check if the user has already submitted
      query += `
        LEFT JOIN submissions s ON a.id = s.assignment_id AND s.user_id = $1
        WHERE e.user_id = $1
        AND a.deadline > NOW()
        AND s.id IS NULL
      `;
    } else {
      query += `
        WHERE e.user_id = $1
        AND a.deadline > NOW()
      `;
    }

    query += `
      ORDER BY a.deadline ASC
      LIMIT $2
    `;

    const result = await db.query(query, [req.user.id, limit]);

    console.log(`Found ${result.rows.length} upcoming assignments`);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching upcoming assignments:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get an assignment by ID
router.get('/:id', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT a.*, u.username as creator_name, c.title as class_title
      FROM assignments a
      JOIN users u ON a.created_by = u.id
      JOIN classes c ON a.class_id = c.id
      WHERE a.id = $1
    `, [req.params.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Assignment not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching assignment:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Create a new assignment (aslab only)
router.post('/', authenticate, authorize(['aslab']), async (req, res) => {
  try {
    const { class_id, title, description, deadline } = req.body;

    if (!class_id || !title || !description || !deadline) {
      return res.status(400).json({ message: 'Class ID, title, description, and deadline are required' });
    }

    // Check if class exists
    const classCheck = await db.query('SELECT * FROM classes WHERE id = $1', [class_id]);
    if (classCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Class not found' });
    }

    const result = await db.query(
      'INSERT INTO assignments (class_id, title, description, deadline, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [class_id, title, description, deadline, req.user.id]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error creating assignment:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Update an assignment (aslab only)
router.put('/:id', authenticate, authorize(['aslab']), async (req, res) => {
  try {
    const { title, description, deadline } = req.body;

    if (!title || !description || !deadline) {
      return res.status(400).json({ message: 'Title, description, and deadline are required' });
    }

    // Check if assignment exists
    const assignmentCheck = await db.query('SELECT * FROM assignments WHERE id = $1', [req.params.id]);
    if (assignmentCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Assignment not found' });
    }

    // Only allow the creator or an aslab to update
    if (assignmentCheck.rows[0].created_by !== req.user.id && req.user.role !== 'aslab') {
      return res.status(403).json({ message: 'Not authorized to update this assignment' });
    }

    const result = await db.query(
      'UPDATE assignments SET title = $1, description = $2, deadline = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $4 RETURNING *',
      [title, description, deadline, req.params.id]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating assignment:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Delete an assignment (aslab only)
router.delete('/:id', authenticate, authorize(['aslab']), async (req, res) => {
  try {
    // Check if assignment exists
    const assignmentCheck = await db.query('SELECT * FROM assignments WHERE id = $1', [req.params.id]);
    if (assignmentCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Assignment not found' });
    }

    // Only allow the creator or an aslab to delete
    if (assignmentCheck.rows[0].created_by !== req.user.id && req.user.role !== 'aslab') {
      return res.status(403).json({ message: 'Not authorized to delete this assignment' });
    }

    await db.query('DELETE FROM assignments WHERE id = $1', [req.params.id]);

    res.json({ message: 'Assignment deleted successfully' });
  } catch (error) {
    console.error('Error deleting assignment:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Submit an assignment (praktikan only)
router.post('/:id/submit', authenticate, authorize(['praktikan']), upload.array('files', MAX_FILES), async (req, res) => {
  try {
    const { content, existingFiles } = req.body;
    const files = req.files;

    // Check if assignment exists
    const assignmentCheck = await db.query('SELECT * FROM assignments WHERE id = $1', [req.params.id]);
    if (assignmentCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Assignment not found' });
    }

    // Check if deadline has passed
    const now = new Date();
    const deadline = new Date(assignmentCheck.rows[0].deadline);
    if (now > deadline) {
      return res.status(400).json({ message: 'Deadline has passed' });
    }

    // Process file uploads and store URLs
    let fileUrls = [];

    // Add existing files that weren't removed
    if (existingFiles) {
      try {
        const parsedExistingFiles = JSON.parse(existingFiles);
        if (Array.isArray(parsedExistingFiles)) {
          fileUrls = [...parsedExistingFiles];
        }
      } catch (e) {
        console.error('Error parsing existing files:', e);
      }
    }

    // Add new files
    if (files && files.length > 0) {
      // Check if total files would exceed the limit
      if (fileUrls.length + files.length > MAX_FILES) {
        return res.status(400).json({
          message: `Cannot add ${files.length} files. Maximum ${MAX_FILES} files allowed per submission. Current count: ${fileUrls.length}`
        });
      }

      // Upload each file to Cloudinary
      for (const file of files) {
        const uploadResult = await uploadFile(file, 'submissions');
        fileUrls.push(uploadResult.url);
      }
    }

    // Convert array of URLs to JSON string for storage
    const fileUrlsJson = JSON.stringify(fileUrls);

    // Check if submission already exists
    const submissionCheck = await db.query(
      'SELECT * FROM submissions WHERE assignment_id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );

    if (submissionCheck.rows.length > 0) {
      // Update existing submission
      const result = await db.query(
        'UPDATE submissions SET content = $1, file_url = $2, updated_at = CURRENT_TIMESTAMP WHERE assignment_id = $3 AND user_id = $4 RETURNING *',
        [content, fileUrlsJson, req.params.id, req.user.id]
      );
      return res.json({ message: 'Submission updated', submission: result.rows[0] });
    } else {
      // Create new submission
      const result = await db.query(
        'INSERT INTO submissions (assignment_id, user_id, content, file_url) VALUES ($1, $2, $3, $4) RETURNING *',
        [req.params.id, req.user.id, content, fileUrlsJson]
      );
      return res.status(201).json({ message: 'Submission created', submission: result.rows[0] });
    }
  } catch (error) {
    console.error('Error submitting assignment:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get submissions for an assignment (aslab only)
router.get('/:id/submissions', authenticate, authorize(['aslab']), async (req, res) => {
  try {
    const result = await db.query(`
      SELECT s.*, u.username, g.grade, g.feedback, g.graded_at, gu.username as graded_by
      FROM submissions s
      JOIN users u ON s.user_id = u.id
      LEFT JOIN grades g ON s.id = g.submission_id
      LEFT JOIN users gu ON g.graded_by = gu.id
      WHERE s.assignment_id = $1
      ORDER BY s.submitted_at DESC
    `, [req.params.id]);

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching submissions:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Grade a submission (aslab only)
router.post('/:id/submissions/:submissionId/grade', authenticate, authorize(['aslab']), async (req, res) => {
  try {
    const { grade, feedback } = req.body;
    const { submissionId } = req.params;

    // Validate grade
    const numericGrade = parseFloat(grade);
    if (isNaN(numericGrade) || numericGrade < 0 || numericGrade > 100) {
      return res.status(400).json({ message: 'Grade must be a number between 0 and 100' });
    }

    // Check if submission exists
    const submissionCheck = await db.query(
      'SELECT * FROM submissions WHERE id = $1 AND assignment_id = $2',
      [submissionId, req.params.id]
    );

    if (submissionCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Submission not found' });
    }

    // Check if grade already exists
    const gradeCheck = await db.query(
      'SELECT * FROM grades WHERE submission_id = $1',
      [submissionId]
    );

    let result;

    if (gradeCheck.rows.length > 0) {
      // Update existing grade
      result = await db.query(
        `UPDATE grades
         SET grade = $1, feedback = $2, graded_at = CURRENT_TIMESTAMP, graded_by = $3
         WHERE submission_id = $4
         RETURNING *`,
        [numericGrade, feedback, req.user.id, submissionId]
      );
    } else {
      // Create new grade
      result = await db.query(
        `INSERT INTO grades (submission_id, grade, feedback, graded_by)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [submissionId, numericGrade, feedback, req.user.id]
      );
    }

    // Get username of grader
    const graderInfo = await db.query(
      'SELECT username FROM users WHERE id = $1',
      [req.user.id]
    );

    const gradeData = {
      ...result.rows[0],
      graded_by: graderInfo.rows[0].username
    };

    res.json({ message: 'Grade saved successfully', grade: gradeData });
  } catch (error) {
    console.error('Error grading submission:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get user's submission for an assignment (including grade and feedback)
router.get('/:id/my-submission', authenticate, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT s.*, g.grade, g.feedback, g.graded_at, u.username as graded_by
      FROM submissions s
      LEFT JOIN grades g ON s.id = g.submission_id
      LEFT JOIN users u ON g.graded_by = u.id
      WHERE s.assignment_id = $1 AND s.user_id = $2
    `, [req.params.id, req.user.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'No submission found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching submission:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get all assignments (for assignment listing page)
router.get('/', authenticate, async (req, res) => {
  try {
    // For aslab, get all assignments
    // For praktikan, get assignments from enrolled classes
    let result;

    if (req.user.role === 'aslab') {
      result = await db.query(`
        SELECT a.*, c.title as class_title, u.username as creator_name
        FROM assignments a
        JOIN classes c ON a.class_id = c.id
        JOIN users u ON a.created_by = u.id
        ORDER BY a.deadline ASC
      `);
    } else {
      // For praktikan, exclude assignments that have already been submitted
      result = await db.query(`
        SELECT a.*, c.title as class_title, u.username as creator_name
        FROM assignments a
        JOIN classes c ON a.class_id = c.id
        JOIN users u ON a.created_by = u.id
        JOIN class_enrollments e ON c.id = e.class_id
        LEFT JOIN submissions s ON a.id = s.assignment_id AND s.user_id = $1
        WHERE e.user_id = $1
        AND (s.id IS NULL OR $2 = false)
        ORDER BY a.deadline ASC
      `, [req.user.id, req.user.role === 'praktikan']);
    }

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching assignments:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
