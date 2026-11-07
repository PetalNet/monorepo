# GitHub PlantUML

This extension renders PlantUML files and rich diffs while you browse GitHub. Build it with `pnpm --filter @petalnet/github-plantuml build`. Load `dist/chrome` unpacked in Chrome, or load `dist/firefox` from Firefox's `about:debugging` page.

Rendering is local by default. The extension fetches only raw files from the GitHub repository currently being viewed; an optional self-hosted PlantUML server can be enabled in the extension options. It supports GitHub blob pages and the current classic, React pull-request, and commit diff views. GitHub DOM changes, unsupported PlantUML features, and server-side includes outside the current repository can prevent a preview.
