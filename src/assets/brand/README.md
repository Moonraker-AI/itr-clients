# Brand assets

Drop the official ITR logo files in this folder. The `build:assets` script
will copy everything here into `dist/static/brand/` and the runtime serves
them under `/static/brand/<filename>`.

## Expected filenames (use these exact names so Layout/AdminShell/ClientShell
## can reference them without code changes):

- **`logo.svg`** — primary mark (vector, preferred). Used in:
  - sidebar header next to "ITR Clients" (admin)
  - brand bar next to "Intensive Therapy Retreats" (client-facing)
  - SVG favicon (modern browsers)
- **`favicon.png`** — 64×64 raster fallback for the favicon. Used as the
  fallback `<link rel="icon">` for browsers that don't support SVG favicons.
- **`apple-touch-icon.png`** *(optional)* — 180×180 for iOS home-screen.

## How to add new assets

1. Drop file in `src/assets/brand/`.
2. `npm run build:assets` (also runs as part of `npm run dev` and
   `npm run build`) → copies to `dist/static/brand/`.
3. Reference at `/static/brand/<filename>` in templates.

Files are excluded from `tsc` because they live outside the `rootDir`
boundary doesn't apply (assets directory). Build script is the only
mechanism that gets them into the runtime image.
