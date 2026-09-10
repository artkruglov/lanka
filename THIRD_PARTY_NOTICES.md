# Third-party components

## Document and workspace chat

- `react-markdown` 10.1.0, MIT, unmodified package. Shared Markdown rendering in agent replies; full notice: `docs/licenses/react-markdown-MIT.txt`.
- `remark-gfm` 4.0.1, MIT, unmodified package. GitHub-flavored Markdown tables and task lists in document chat; full notice: `docs/licenses/remark-gfm-MIT.txt`.

- `@assistant-ui/react` 0.15.18 and `@assistant-ui/react-markdown` 0.14.14, MIT, unmodified packages. React chat primitives and Markdown rendering with our ExternalStoreRuntime adapter. Copyright AgentbaseAI Inc.; full notice: `docs/licenses/assistant-ui-MIT.txt`. No Assistant Cloud service is used by this integration.
- `pg` 8.23.0, MIT, unmodified PostgreSQL client. Copyright Brian Carlson; full notice: `docs/licenses/pg-MIT.txt`. PostgreSQL itself is an external installation prerequisite, not bundled database server code.

| Component                                                                     | Version             | License                          | Actual use                                                                                                                                                                  |
| ----------------------------------------------------------------------------- | ------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [CreatPPT](https://github.com/seekskyworld/CreatPPT) / @seekskyworld/creatppt | 0.1.4               | Apache-2.0                       | Public `parseBrief` parser and geometry `CANVAS`, `box`, `inset`, `canvasToInches`; wrapped by our canonical document/scene adapters. No modifications to upstream package. |
| [PptxGenJS](https://github.com/gitbrent/PptxGenJS)                            | 4.0.1               | MIT                              | Editable PPTX text, shapes, images, notes and OOXML packaging.                                                                                                              |
| [pdf-lib](https://github.com/Hopding/pdf-lib)                                 | 1.17.1              | MIT                              | PDF pages, fonts, text, shapes and images.                                                                                                                                  |
| @pdf-lib/fontkit                                                              | 1.1.1               | MIT                              | Unicode font embedding/subsetting.                                                                                                                                          |
| DejaVu Sans (regular, bold)                                                   | system distribution | Bitstream Vera / DejaVu licenses | Bundled font files and extracted advance-width metrics. License: `public/fonts/LICENSE.txt`.                                                                                |
| React / shadcn / Radix / Lucide / Zod / Drizzle / Vinext                      | lockfile            | Respective upstream licenses     | Application interface, validation and runtime. See each installed package.                                                                                                  |

Copies of CreatPPT, PptxGenJS and pdf-lib licenses are in `docs/licenses/`. Upstream copyright notices are preserved in the distributed npm dependencies. DejaVu font modifications: none; `font-metrics.json` contains derived glyph advances for layout. Plex font metadata corrections are documented below.

[Presenton](https://github.com/presenton/presenton) (Apache-2.0) was examined as an architectural reference; this version does not copy or embed its code. PPTist was not copied. The supplied PRDs contain GitHub references; no additional concrete GitLab repository was available to reuse. Future integrations must inspect the exact repository, pinned revision, license and notices before importing code.

## Added in 0.4

- [OpenAI Codex](https://github.com/openai/codex), npm `@openai/codex` 0.153.4, Apache-2.0 as declared by the installed package. Unmodified official CLI/platform binary; used through its App Server protocol in the separate worker. The runtime lockfile pins the distribution. Upstream license: [LICENSE](https://github.com/openai/codex/blob/main/LICENSE).
- Poppler `pdftotext` is installed from Debian repositories in the separate worker image to extract PDF text. Distribution versions and notices belong to that image; no Poppler code is copied into the web bundle. Local container build/acceptance records are in `docs/planning/SELF_HOSTED_CONTAINER_ACCEPTANCE.md`; no image has been published.
- Python standard-library `zipfile` / `xml.etree` implement bounded Office text extraction. This is our limited adapter, not a copied PowerPoint renderer or full Office importer.

## Added in 0.5

- [jose](https://github.com/panva/jose), npm 6.2.11, MIT as declared by the installed package. Used without modification to validate Cloudflare Access JWT signatures and claims in the external deployment wrapper; pinned in the root lockfile. License copy: `docs/licenses/jose-MIT.txt`.

## Added in 0.6

- JSZip 3.10.1, unmodified, selected under the MIT option of its dual MIT/GPLv3 license. Already present transitively through export dependencies; now declared directly for portable project ZIPs. Full upstream notice preserved at `docs/licenses/jszip-LICENSE.txt`.

## Focus 3 design candidate

- IBM Plex Sans Regular/SemiBold and IBM Plex Mono Medium, supplied in the Focus 3 handoff, SIL Open Font License 1.1. License copies: `public/fonts/OFL-IBMPlexSans.txt` and `public/fonts/OFL-IBMPlexMono.txt`. The static Sans SemiBold instance had Regular name records; only those name records were corrected by `scripts/normalize-plex-fonts.py`. Glyph outlines, widths and vertical metrics are unchanged. `lib/domain/font-metrics-plex.json` contains derived glyph advances.
- Playwright 1.58.2 (Apache-2.0), pngjs 7.0.0 (MIT), pixelmatch 7.1.0 (ISC): development-only raster comparison tooling, unmodified npm packages with their upstream notices retained. Chrome/Chromium and Poppler are external test prerequisites, not shipped in the application bundle.

## Machine-readable npm inventory

Generate a lockfile-based CycloneDX package using `npm run package:sbom -- <new-output-directory>`. See CONTRIBUTING.md for scope and checks. Font and non-npm notices above remain necessary; this inventory does not choose a license for Lanka itself.

## Offline SBOM validation

- Unmodified CycloneDX 1.5 JSON schemas (including referenced SPDX and JSF schemas): upstream Apache-2.0 license and attribution retained in `vendor/cyclonedx-1.5/LICENSE` and the schema files. Origins are listed in that directory’s README.
- Ajv 8.20.0 and ajv-formats 2.1.1: MIT, unmodified development dependencies pinned in package-lock.json; upstream license files remain in their npm packages.
