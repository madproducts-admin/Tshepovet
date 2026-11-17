# design/

The app's design reference, edited by the owner in the project dashboard (`dashboard.html`, its
Design system and User interface tabs) and carried here by `tools/design-sync.mjs`:

- `tokens.json`: the colours (light and dark), the contrast pairs that must pass, the type
  families and scale, radii and shadows. `apps/web/app/tokens.css` is generated from it.
- `pages.json`: every page of the web app (route, area, shell, who can open it, its blocks top to
  bottom) and the shells they sit in. A page is `built` or `planned`; `notes` carries the owner's
  change requests.

```
npm run design:pull    # dashboard.html -> design/*.json -> apps/web/app/tokens.css
npm run design:push    # design/*.json -> dashboard.html
npm run design:check   # the app agrees with design/*.json (tokens, AAA contrast, fonts, pages)
npm run design:css     # regenerate tokens.css after editing tokens.json by hand
```

See `apps/web/DESIGN.md` for the system itself.
