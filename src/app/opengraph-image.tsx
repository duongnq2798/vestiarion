import { SOCIAL_IMAGE_ALT, SOCIAL_IMAGE_SIZE, socialPreviewImage } from "./_og/SocialPreview";

export const alt = SOCIAL_IMAGE_ALT;
export const size = SOCIAL_IMAGE_SIZE;
export const contentType = "image/png";

export default function Image() {
  return socialPreviewImage();
}
