const express = require('express');
const router = express.Router();
const { cloudinary } = require('../config/cloudinary');

router.post('/image', async (req, res) => {
  try {
    const { image } = req.body;
    
    // Check if image is provided
    if (!image) {
      return res.status(400).json({ error: 'No image data provided' });
    }

    // Extract base64 data from data URL
    const base64Data = image.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');

    // Get the file type from the data URL
    const fileType = image.match(/^data:image\/(\w+);/)[1];

    // Upload to Cloudinary
    const result = await cloudinary.uploader.upload(image, {
      folder: 'markdown-images',
      resource_type: 'image',
      access_mode: 'public',
      type: 'upload'
    });

    res.json({
      url: result.secure_url,
      public_id: result.public_id
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Failed to upload image' });
  }
});

module.exports = router;
