# BasedPL APL Reference

Keyboard-first APL glyph reference built around the official BasedPL documentation.

## Development

The source site lives in `src/index.html`.

Build locally:

```bash
python build.py
```

The generated site is written to `dist/index.html`.

## Deployment

GitHub Actions deploys the site to GitHub Pages:

- automatically on pushes to `main`
- manually through **Actions → Deploy BasedPL APL Reference → Run workflow**

Set the repository's Pages source to **GitHub Actions** under **Settings → Pages**.
