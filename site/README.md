# Wipeout website

The download page for Wipeout, deployed on Vercel. Plain HTML, CSS and a few
lines of JavaScript: no build step, no framework, no trackers.

- Deploy: in Vercel, import the repo and set **Root Directory** to `site`
  (framework preset: Other, no build command).
- The address is `https://getwipeout.vercel.app`. If it changes, update it in
  `index.html` (canonical, `og:url`, `og:image`, JSON-LD), `robots.txt` and
  `sitemap.xml`.
- Fonts: Barlow Condensed (SIL Open Font License, see `assets/fonts/OFL.txt`).
