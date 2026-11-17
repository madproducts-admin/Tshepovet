# design/

The app's design reference. The owner edits it in the project dashboard (`dashboard.html` next to
the repository root, kept out of git with its `temp/` upload folder: the repository is public):
its Color Palette & Themes, Typography & Font Scaling, Layout & Structure and Brand Assets &
Micro-interactions tabs. Every edit there is a **requested change** that waits until Claude applies
it; `tools/design-sync.mjs` carries the reference between the dashboard and these files.

- `tokens.json`: colours in both themes (grouped, with what each is for), the contrast pairs that
  must pass, the fonts and type roles, the type scale, settings for themes, typography, layout,
  brand and motion, the rules and the building blocks. Settings that carry a `token` reach the app
  by themselves: `apps/web/app/tokens.css` is generated from this file.
- `pages.json`: every page of the web app (route, area, shell, who can open it, its regions top to
  bottom with a kind and a width), the shells and their navigation. A `proposed` page is planned,
  not built; `request` carries the owner's change request for a page.

```
npm run design:pending           what waits for Claude in the dashboard
npm run design:pull              dashboard -> design/*.json -> apps/web/app/tokens.css
                                 (refuses colours under their contrast minimum; writes nothing then)
npm run design:applied -- <sha>  mark the requested changes applied (after the commit)
npm run design:declined -- <change-id> <reason>   refuse one, and put its old value back
node tools/design-sync.mjs handled <id>...         a decision or a blocker's instruction acted on
npm run design:push              design/*.json -> the dashboard (requests, uploads, answers kept)
npm run design:check             the app agrees with design/*.json: generated tokens, AAA contrast,
                                 fonts, every page listed (gates the browser tests and the deploy)
npm run design:css               regenerate tokens.css after editing tokens.json by hand
```

## When the owner says "Sync the dashboard"

1. Read `dashboard.html` (its `#dashboard-state`), compare `updatedAt` with the last write, and run
   `npm run design:pending`. Uploaded files are in `temp/`.
2. Values that carry a token (colours, the type scale, the interface scale, radii, layout widths,
   motion timing): `npm run design:pull`. If it refuses a colour, decline that change with the
   failing pairs as the reason (`design:declined`) and pull again.
3. Everything else (fonts, rules, brand text, components, page regions and change requests,
   uploads): change the code. A page added or removed in the code goes into `pages.json` too.
4. Act on answers, recorded decisions and blocker instructions (`handled` when done).
5. Test (`npm run design:check`, the API suite, the browser suite), commit, then mark the changes
   `applied` with the commit, `push` so the dashboard shows the code as it now is, and add a log
   entry. Going live is a separate decision: add it under Open Decisions and wait for the owner.

See `apps/web/DESIGN.md` for the design system itself.
