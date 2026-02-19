/**
 * Cloudinary config: supports either three separate env vars or a single CLOUDINARY_URL.
 * CLOUDINARY_URL format: cloudinary://api_key:api_secret@cloud_name
 */
function getCloudinaryConfig() {
  const cloud_name = process.env.CLOUDINARY_CLOUD_NAME;
  const api_key = process.env.CLOUDINARY_API_KEY;
  const api_secret = process.env.CLOUDINARY_API_SECRET;

  if (cloud_name && api_key && api_secret) {
    return { cloud_name, api_key, api_secret };
  }

  const url = process.env.CLOUDINARY_URL;
  if (url && url.startsWith('cloudinary://')) {
    try {
      const parsed = new URL(url);
      const api_key_from_url = parsed.username;
      const api_secret_from_url = parsed.password;
      const cloud_name_from_url = parsed.hostname;
      if (api_key_from_url && api_secret_from_url && cloud_name_from_url) {
        return {
          cloud_name: cloud_name_from_url,
          api_key: api_key_from_url,
          api_secret: api_secret_from_url,
        };
      }
    } catch (_) {
      // ignore parse errors
    }
  }

  return null;
}

module.exports = { getCloudinaryConfig };
