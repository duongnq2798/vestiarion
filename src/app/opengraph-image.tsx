import { socialPreviewImage } from "./_og/SocialPreview";

export const alt = "Vestiarion — Money moves. Evidence remains. A signed decision ledger with screened, paid, held, and refused outcomes.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function Image() {
  return socialPreviewImage();
}
