/**
 * Build the @openbot/ui story page (src/gallery.tsx) with Bun's HTML bundler + Tailwind.
 *   bun run packages/ui/scripts/build-gallery.ts [outdir]
 */
import tailwind from "bun-plugin-tailwind"

export const galleryEntry = new URL("../src/gallery/gallery.html", import.meta.url).pathname

export const buildGallery = async (outdir: string): Promise<string> => {
  const result = await Bun.build({
    entrypoints: [galleryEntry],
    outdir,
    plugins: [tailwind],
    minify: false,
    target: "browser",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
  })
  if (!result.success) throw new AggregateError(result.logs, "gallery build failed")
  return `${outdir}/gallery.html`
}

if (import.meta.main) {
  const outdir = process.argv[2] ?? new URL("../.gallery-dist", import.meta.url).pathname
  console.log(await buildGallery(outdir))
}
