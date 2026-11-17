# Design pages

Rendered HTML versions of the TshepoVet docs, published as private claude.ai pages. Each file here is the published page's source with a minimal HTML shell added, so it also opens directly in a browser.

| Page | File | Built from | Published |
|---|---|---|---|
| TshepoVet README | [readme.html](readme.html) | `README.md`, prices from `db/migrations/0002_seed_reference_data.sql` | [link](https://claude.ai/artifact/TffwU1tZSYPskHMrim4vMt) |
| TshepoVet Architecture & Compliance | [architecture-compliance.html](architecture-compliance.html) | `docs/01-architecture.md`, `docs/03-popia-sars-compliance.md` | [link](https://claude.ai/artifact/MP58H22t29JpVKY7b9vtPW) |
| TshepoVet WhatsApp Onboarding | [whatsapp-onboarding.html](whatsapp-onboarding.html) | `docs/04-whatsapp-ocr-onboarding.md`, bot copy from `src/whatsapp/messages.ts` | [link](https://claude.ai/artifact/1ZUwVgHKksnCriUEyjua3o) |
| TshepoVet Database Schema | [database-schema.html](database-schema.html) | `docs/02-database-schema.md`, SQL excerpts from `db/migrations/0001_init.sql` | [link](https://claude.ai/artifact/FiCj3NRZZ1YG5DTcPG3Abb) |
| TshepoVet Verification API | [verification-api.html](verification-api.html) | `docs/05-api.md`, `openapi/openapi.yaml`, `README.md` | [link](https://claude.ai/artifact/9zS9q39GCCbB5F8ysAVU9R) |

The same files are also the source of the public docs site at https://tshepovet.madproducts.ai (`README` at `/`, the others at clean paths such as `/database-schema`). Its build (`tools/build-site.mjs`) adapts a copy: the claude.ai links become site paths, the mermaid diagrams become inline SVG, the inline scripts move into files, and each page gets a build id. So keep writing these pages for claude.ai; the site follows. See [deploy/README.md](../../deploy/README.md).

Notes:

- The Markdown docs in `docs/` remain the source of truth. If a doc changes, update the matching page, republish it to the same link and redeploy the site (`npm run deploy`).
- A new page needs an entry in `tools/lib/site.json` (its claude.ai id and site path), or the site build fails on links to it.
- The architecture, WhatsApp and schema pages contain mermaid diagrams. The published pages render them; opened locally, they show as diagram source. The same diagrams render on GitHub in the Markdown docs.
- Links between pages point to the published claude.ai URLs, which are private: viewers need the pages shared with them.
- Fonts load from Google Fonts; offline, the pages fall back to system fonts.
