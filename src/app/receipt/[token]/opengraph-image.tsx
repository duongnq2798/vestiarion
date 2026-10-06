import { LINK_PREVIEWS, SOCIAL_IMAGE_SIZE, linkPreviewImage } from "@/app/_og/SocialPreview";

/** This page's card for a link pasted into a chat (mainnet polish E1): the page's kind, nothing of the link. */
export const alt = LINK_PREVIEWS.receipt.alt;
export const size = SOCIAL_IMAGE_SIZE;
export const contentType = "image/png";

export default function Image() {
  return linkPreviewImage("receipt");
}
