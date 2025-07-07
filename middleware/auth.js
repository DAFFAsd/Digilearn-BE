const jwt = require('jsonwebtoken');
const { createClient } = require('redis');
const dotenv = require('dotenv');

dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET;
const REDIS_URL = process.env.REDIS_URL;

// Initialize Redis client
let redisClient;

const connectRedis = async () => {
  try {
    redisClient = createClient({
      url: REDIS_URL
    });

    redisClient.on('error', (err) => {
      console.error('Redis client error:', err);
    });

    await redisClient.connect();
    console.log('Connected to Redis');
  } catch (error) {
    console.error('Redis connection error:', error);
  }
};

connectRedis();

// Authentication middleware
const authenticate = async (req, res, next) => {
  try {
    // Get token from cookies or Authorization header
    const token = req.cookies.token || req.header('Authorization')?.replace('Bearer ', '');
    
    if (!token) {
      return res.status(401).json({ message: 'Authentication required' });
    }

    // Verify token
    const decoded = jwt.verify(token, JWT_SECRET);
    
    // For logout route, allow the request to proceed without additional checks
    if (req.path === '/logout') {
      req.user = decoded;
      req.token = token;
      return next();
    }
    
    // For non-logout routes, check if token is still valid for this user
    const storedToken = await redisClient.get(`user_token:${decoded.id}`);
    if (!storedToken || storedToken !== token) {
      return res.status(401).json({ message: 'Session invalid, please login again' });
    }

    // Add user data to request
    req.user = decoded;
    req.token = token;
    
    next();
  } catch (error) {
    console.error('Authentication error:', error);
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ message: 'Session expired, please login again' });
    }
    res.status(401).json({ message: 'Invalid authentication token' });
  }
};

// Role-based authorization middleware
const authorize = (roles = []) => {
  if (typeof roles === 'string') {
    roles = [roles];
  }

  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: 'Authentication required' });
    }

    if (roles.length && !roles.includes(req.user.role)) {
      return res.status(403).json({ message: 'Insufficient permissions' });
    }

    next();
  };
};

module.exports = {
  authenticate,
  authorize,
  redisClient,
  JWT_SECRET
};
