const express = require('express');
const axios = require('axios');
const contentDisposition = require('content-disposition');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

/**
 * Download a file with a custom filename
 * This endpoint proxies the file from Cloudinary and sets the Content-Disposition header
 * to force download with the original filename
 */
router.get('/', async (req, res) => {
  try {
    const { url, filename } = req.query;

    if (!url) {
      return res.status(400).json({ message: 'URL is required' });
    }

    if (!filename) {
      return res.status(400).json({ message: 'Filename is required' });
    }

    // Fetch the file from Cloudinary
    const response = await axios({
      method: 'GET',
      url: url,
      responseType: 'stream'
    });

    // Set headers to force download with the original filename
    res.setHeader('Content-Disposition', contentDisposition(filename));
    
    // Set content type if available
    if (response.headers['content-type']) {
      res.setHeader('Content-Type', response.headers['content-type']);
    }
    
    // Set content length if available
    if (response.headers['content-length']) {
      res.setHeader('Content-Length', response.headers['content-length']);
    }

    // Stream the file to the client
    response.data.pipe(res);
  } catch (error) {
    console.error('Error downloading file:', error);
    res.status(500).json({ message: 'Failed to download file' });
  }
});

module.exports = router;
