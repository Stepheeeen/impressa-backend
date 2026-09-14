import { v2 as cloudinary } from "cloudinary";
import { env } from "../config/env";
import { HttpError } from "../middleware/errorHandler";

const ID_DOCUMENT_FOLDER = "merchant-ids";
const configured = Boolean(env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET);

if (configured) {
  cloudinary.config({
    cloud_name: env.CLOUDINARY_CLOUD_NAME,
    api_key: env.CLOUDINARY_API_KEY,
    api_secret: env.CLOUDINARY_API_SECRET,
    secure: true,
  });
}

function ensureConfigured() {
  if (!configured) throw new HttpError(503, "ID uploads aren't set up yet. Try again later.");
}

export const isIdDocumentPublicId = (publicId: string) => publicId.startsWith(`${ID_DOCUMENT_FOLDER}/`);

// Signs one upload so the app can send an ID photo straight to Cloudinary as a private file.
export function signIdDocumentUpload() {
  ensureConfigured();
  const timestamp = Math.floor(Date.now() / 1000);
  const params = { folder: ID_DOCUMENT_FOLDER, timestamp, type: "private" };
  return {
    cloudName: env.CLOUDINARY_CLOUD_NAME,
    apiKey: env.CLOUDINARY_API_KEY!,
    ...params,
    signature: cloudinary.utils.api_sign_request(params, env.CLOUDINARY_API_SECRET!),
  };
}

// A link for an admin to view a private ID document. It stops working after 10 minutes.
export function idDocumentUrl(publicId: string, format: string) {
  ensureConfigured();
  return cloudinary.utils.private_download_url(publicId, format, {
    type: "private",
    expires_at: Math.floor(Date.now() / 1000) + 10 * 60,
  });
}
