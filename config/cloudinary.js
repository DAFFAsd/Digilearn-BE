const cloudinary = require('cloudinary').v2;
const dotenv = require('dotenv');

dotenv.config();

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'dnkkk7pgw',
  api_key: process.env.CLOUDINARY_API_KEY || '612347442264637',
  api_secret: process.env.CLOUDINARY_API_SECRET || 'tbXNmU3pq5kvXWa0tttRWevUChE'
});

// Upload file to Cloudinary
const uploadFile = async (file, folder = 'digilab') => {
  try {
    // Check if file is a string path or a file object
    const isFilePath = typeof file === 'string';

    // Set upload options
    const uploadOptions = {
      folder: folder,
      resource_type: 'auto',
      access_mode: 'public', // Ensure public access
      type: 'upload',        // Explicit upload type
    };

    // If file is an object with mimetype, check if it's a PDF
    if (!isFilePath && file.mimetype) {
      const isPDF = file.mimetype === 'application/pdf';

      // Add specific options for PDFs
      if (isPDF) {
        uploadOptions.resource_type = 'raw';
        uploadOptions.flags = 'attachment'; // Force as attachment to prevent ACL issues
      }
    }

    // Use the file path directly if it's a string, otherwise use file.path
    const filePath = isFilePath ? file : file.path;

    const result = await cloudinary.uploader.upload(filePath, uploadOptions);

    return {
      secure_url: result.secure_url,
      url: result.url,
      public_id: result.public_id
    };
  } catch (error) {
    console.error('Cloudinary upload error:', error);
    throw new Error('File upload failed');
  }
};

// Delete file from Cloudinary
const deleteFile = async (publicId) => {
  try {
    await cloudinary.uploader.destroy(publicId);
    return { success: true };
  } catch (error) {
    console.error('Cloudinary delete error:', error);
    throw new Error('File deletion failed');
  }
};

// Fix access for an existing file
const fixFileAccess = async (publicId) => {
  try {
    // Update the resource to be publicly accessible
    const result = await cloudinary.uploader.explicit(publicId, {
      type: 'upload',
      access_mode: 'public',
      resource_type: 'auto'
    });

    return {
      url: result.secure_url,
      public_id: result.public_id
    };
  } catch (error) {
    console.error('Cloudinary access fix error:', error);
    throw new Error('Failed to fix file access');
  }
};

module.exports = {
  cloudinary,
  uploadFile,
  deleteFile,
  fixFileAccess
};
