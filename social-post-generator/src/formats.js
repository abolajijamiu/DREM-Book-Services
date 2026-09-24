// Every platform and size the generator renders. Sizes are in pixels.
// "safe" is the inset (top/bottom) where platform UI covers the image, e.g. story bars.
export const PLATFORMS = {
  instagram: {
    label: 'Instagram',
    captionLimit: 2200,
    hashtagLimit: 30,
    formats: {
      portrait: { w: 1080, h: 1350 },
      tall: { w: 1080, h: 1440 },
      square: { w: 1080, h: 1080 },
      landscape: { w: 1080, h: 566 },
      story: { w: 1080, h: 1920, safe: 250 },
    },
    carousel: 'portrait',
  },
  facebook: {
    label: 'Facebook',
    captionLimit: 63206,
    formats: {
      landscape: { w: 1200, h: 630 },
      square: { w: 1080, h: 1080 },
      portrait: { w: 1080, h: 1350 },
      story: { w: 1080, h: 1920, safe: 250 },
    },
    carousel: 'square',
  },
  x: {
    label: 'X / Twitter',
    captionLimit: 280,
    formats: {
      landscape: { w: 1200, h: 675 },
      square: { w: 1080, h: 1080 },
      portrait: { w: 1080, h: 1350 },
    },
    // X shows at most 4 images per post; carousels are cut down to that.
    carousel: 'square',
    maxImages: 4,
  },
  linkedin: {
    label: 'LinkedIn',
    captionLimit: 3000,
    formats: {
      landscape: { w: 1200, h: 627 },
      square: { w: 1080, h: 1080 },
      portrait: { w: 1080, h: 1350 },
    },
    // Carousels are also exported as a PDF "document" post.
    carousel: 'square',
    carouselPdf: true,
  },
  threads: {
    label: 'Threads',
    captionLimit: 500,
    formats: {
      portrait: { w: 1080, h: 1350 },
      square: { w: 1080, h: 1080 },
    },
    carousel: 'portrait',
  },
  pinterest: {
    label: 'Pinterest',
    captionLimit: 500,
    formats: {
      pin: { w: 1000, h: 1500 },
    },
    carousel: 'pin',
  },
  tiktok: {
    label: 'TikTok',
    captionLimit: 2200,
    formats: {
      vertical: { w: 1080, h: 1920, safe: 300 },
    },
    carousel: 'vertical',
  },
  whatsapp: {
    label: 'WhatsApp Status',
    captionLimit: 700,
    formats: {
      status: { w: 1080, h: 1920, safe: 200 },
    },
    carousel: 'status',
  },
};

// Picks the layout family from the aspect ratio so one template serves every size.
export function layoutFor({ w, h }) {
  const r = w / h;
  if (r >= 1.5) return 'wide';
  if (r >= 0.95) return 'square';
  if (r >= 0.6) return 'tall';
  return 'story';
}
