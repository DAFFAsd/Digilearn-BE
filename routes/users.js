const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { authenticate, authorize, redisClient, JWT_SECRET } = require('../middleware/auth');
const db = require('../db');
const { uploadFile } = require('../config/cloudinary');

const router = express.Router();

// Configure multer for file uploads
const upload = multer({ dest: 'uploads/' });

// Register a new user
router.post('/register', async (req, res) => {
  try {
    const { username, email, password, role } = req.body;

    // Validate input
    if (!username || !email || !password) {
      return res.status(400).json({ message: 'Username, email, and password are required' });
    }

    // Validate role - only allow praktikan and aslab roles for registration
    if (!['aslab', 'praktikan'].includes(role)) {
      return res.status(400).json({ message: 'Invalid role. Only praktikan and aslab roles are allowed for registration.' });
    }

    // For aslab registration, validate the special code in the middleware
    // This is handled on the frontend side

    // Check if username or email already exists
    const existingUser = await db.query(
      'SELECT * FROM users WHERE username = $1 OR email = $2',
      [username, email]
    );

    if (existingUser.rows.length > 0) {
      return res.status(400).json({ message: 'Username or email already exists' });
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Create user
    const result = await db.query(
      'INSERT INTO users (username, email, password, role) VALUES ($1, $2, $3, $4) RETURNING id, username, email, role, created_at',
      [username, email, hashedPassword, role]
    );

    const user = result.rows[0];

    // Generate JWT token with a unique jti (JWT ID) claim
    const jti = require('crypto').randomBytes(16).toString('hex');
    const token = jwt.sign(
      { 
        id: user.id, 
        username: user.username, 
        email: user.email, 
        role: user.role,
        jti: jti // Add unique identifier
      },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Store token in Redis with user ID for reference
    await redisClient.set(`user_token:${user.id}`, token, {
      EX: 7 * 24 * 60 * 60 // 7 days in seconds
    });

    // Set cookie
    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    });

    res.status(201).json({
      message: 'User registered successfully',
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        created_at: user.created_at
      },
      token
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // Validate input
    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required' });
    }

    // Find user
    const result = await db.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    // Verify password
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    // Generate JWT token with a unique jti (JWT ID) claim
    const jti = require('crypto').randomBytes(16).toString('hex');
    const token = jwt.sign(
      { 
        id: user.id, 
        username: user.username, 
        email: user.email, 
        role: user.role,
        jti: jti // Add unique identifier
      },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Store token in Redis with user ID for reference
    await redisClient.set(`user_token:${user.id}`, token, {
      EX: 7 * 24 * 60 * 60 // 7 days in seconds
    });

    // Set cookie
    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    });

    res.json({
      message: 'Login successful',
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role
      },
      token
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Logout
router.post('/logout', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    
    console.log('Logging out user:', userId);
    
    // Remove the active token for this user
    await redisClient.del(`user_token:${userId}`);
    console.log('Removed user token from Redis');
    
    // Clear the cookie
    res.clearCookie('token');
    
    res.json({ message: 'Logout successful' });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get current user
router.get('/me', authenticate, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT id, username, email, role, created_at, profile_image FROM users WHERE id = $1',
      [req.user.id]
    );

    const user = result.rows[0];
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.json(user);
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Update user profile
router.put('/profile', authenticate, upload.single('profileImage'), async (req, res) => {
  try {
    const { username } = req.body;
    const userId = req.user.id;

    // Validate username
    if (!username) {
      return res.status(400).json({ message: 'Username is required' });
    }

    // Check if username is already taken by another user
    const existingUser = await db.query(
      'SELECT * FROM users WHERE username = $1 AND id != $2',
      [username, userId]
    );

    if (existingUser.rows.length > 0) {
      return res.status(400).json({ message: 'Username is already taken' });
    }

    let profileImageUrl = null;

    // Upload profile image if provided
    if (req.file) {
      try {
        // Upload to Cloudinary
        const result = await uploadFile(req.file);
        profileImageUrl = result.secure_url;

        // Clean up the temporary file
        fs.unlinkSync(req.file.path);
      } catch (uploadError) {
        console.error('Error uploading profile image:', uploadError);
        return res.status(500).json({ message: 'Error uploading profile image' });
      }
    }

    // Update user in database
    let updateQuery, queryParams;

    if (profileImageUrl) {
      // Update both username and profile image
      updateQuery = `
        UPDATE users
        SET username = $1, profile_image = $2, updated_at = CURRENT_TIMESTAMP
        WHERE id = $3
        RETURNING id, username, email, role, created_at, profile_image
      `;
      queryParams = [username, profileImageUrl, userId];
    } else {
      // Update only username
      updateQuery = `
        UPDATE users
        SET username = $1, updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
        RETURNING id, username, email, role, created_at, profile_image
      `;
      queryParams = [username, userId];
    }

    const result = await db.query(updateQuery, queryParams);
    const updatedUser = result.rows[0];

    res.json(updatedUser);
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
