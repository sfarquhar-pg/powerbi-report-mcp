<!-- doc-version: 2.5 | Last updated: 2026-10-01 -->
# Changelog — powerbi-report-mcp

Each release has its own file in [`changelog/`](changelog/).

| Version | Date | Highlights |
|---------|------|------------|
| [**0.12.0**](changelog/v0.12.0.md) | 2026-08-27 | **Component fit engine + wrap-aware text fit + typography roles.** |
| [**0.11.1**](changelog/v0.11.1.md) | 2026-08-27 | **Theme-driven typography + audit refinements.** |
| [**0.11.0**](changelog/v0.11.0.md) | 2026-08-27 | **`pbir_audit_style_consistency` — the styling gate.** |
| [**0.10.3**](changelog/v0.10.3.md) | 2026-08-27 | **Drillthrough pages importable by Fabric.** |
| [**0.10.2**](changelog/v0.10.2.md) | 2026-08-27 | **Derived visual-style defaults + image visual fix.** |
| [**0.10.1**](changelog/v0.10.1.md) | 2026-08-27 | **PBIR-Legacy support for `pbir_fabric_mirror_style`.** |
| [**0.10.0**](changelog/v0.10.0.md) | 2026-08-27 | **`pbir_fabric_mirror_style` — mirror the look of any report from its link.** |
| [**0.9.6**](changelog/v0.9.6.md) | 2026-05-07 | **`pbir_validate_wireframe` — layout validator over the wire.** |
| [**0.9.5**](changelog/v0.9.5.md) | 2026-05-06 | **Tier C.1 catalog reduction + `pbir_guide` fix.** |
| [**0.9.4**](changelog/v0.9.4.md) | 2026-05-04 | **Loose ends — consistency patch.** |
| [**0.9.3**](changelog/v0.9.3.md) | 2026-05-04 | **Bug fix: measure home-table auto-resolution.** |
| [**0.9.2**](changelog/v0.9.2.md) | 2026-05-02 | **Small polish — read enrichments + checklist skill + gotchas (8 of 9 backlog items, item 6 deferred).** |
| [**0.9.1**](changelog/v0.9.1.md) | 2026-04-27 | **Bug fix: `pbir_set_report` -32602 in strict MCP clients.** |
| [**0.9.0** addendum](changelog/v0.9.0-wireframe-scaffolder.md) | 2026-04-26 | **Wireframe scaffolder artifact.** |
| [**0.9.0**](changelog/v0.9.0.md) | 2026-04-26 | **Pagination aliases + eval infrastructure.** |
| [**0.8.2**](docs/archive/changelog/v0.8.2.md) | 2026-04-26 | **outputSchema tightening + README polish.** |
| [**0.8.1**](changelog/v0.8.1.md) | 2026-04-25 | **Pagination + per-skill resources.** |
| [**0.8.0**](changelog/v0.8.0.md) | 2026-04-25 | **Audit-driven refactor (BREAKING).** |
| **0.6.3** *(unreleased)* | 2026-04-18 | **Reliability & perf pass.** `parseTmdlRelationships` / `parseTmdlFunctions` / `parseTmdlModel` / `parseBimFile` now wrap reads in try/catch — a corrupt or locked TMDL/BIM file no longer crashes the whole `model_usage` load; the section returns `[]`, warn-once stderr, and `parseWarnings[]` appears on the response (#9). `PbirProject` gained an in-memory mtime-keyed visual.json cache — `list_visuals` / `get_visual` / bulk ops now avoid redundant disk reads, ~20× cheaper on warm calls (#11). `usageCache` replaced with a per-reportPath `Map` keyed by a model-file mtime fingerprint, so multi-report workflows cache correctly instead of rebuilding every call (#12). `regenerate()` and the `model_usage` HTML write switched to `fs.promises.writeFile` — bulk ops no longer stutter behind 58KB sync writes (#14). `parseBimFile` replaced `any` casts with structural BIM types (`BimRoot`/`BimTable`/`BimMeasure`/etc.) — stricter types, same output (#7). `bulk_bind` now accepts `continueOnError: true` — runs validation per-entry and reports bad visuals in a `perEntryBindingErrors` field instead of aborting the whole batch (#18). README "Smart Tool Loading" rewritten to reflect the v0.6.2 default flip (load-all) and document `MCP_TOOLS=minimal` opt-in for token-sensitive clients (#16). |
| **0.6.2** | 2026-04-17 | **Default tool-loading flipped to load-all** so Claude Desktop works out of the box — new users no longer see "only 11 tools" and assume the server is broken. `MCP_TOOLS=minimal` is the new opt-in for token-sensitive setups (Claude Code etc.); `MCP_TOOLS=all` kept as a backward-compat alias for `default`. **Pre-launch security hardening (4 findings from `/sc:analyze`):** #2 shell-injection fix in `reload_report` — `execSync("start " + path)` replaced with `spawn("cmd.exe", ["/c","start","",path], {shell:false})` + regex allowlist on `.pbip` filename. #3 path-traversal defence for `StaticResources` — regex allowlist + `path.basename()` + prefix check catches symlink/Unicode escapes. #6 `extractVisualTitle()` helper extracted (`src/helpers/extractTitle.ts`) — three inline copies of the same PBIR title-extraction logic consolidated, empty-quoted-string edge case handled, 12-case smoke test gated in CI. #17 `MCPResult` helpers added (`src/helpers/mcpResult.ts`) — `ok()` / `fail()` / `raw()` standardize the tool response shape with the MCP-spec-required `isError: true` on failures. **Safety caps (#5, #8):** `BULK_MAX_ITEMS = 1000` hard ceiling on `bulk_delete_visuals` / `bulk_update_format` / `bulk_bind` on top of the existing `confirmBulk` soft gate. Binding-validation telemetry — `bindingValidation.skipped` field surfaces in responses when the sibling `.SemanticModel` can't be found or model parse fails, plus once-per-path stderr warnings so silent degrade is observable. New `_resetBindingValidationWarnings()` test seam. `isNoteworthySkip()` classifier distinguishes mode-off from model-not-found/parse-error. Binding-validator suite expanded 25 → 29 cases (adds SKIP 1-4 section). New title-extractor suite gated via `.githooks/pre-commit` + `.github/workflows/ci.yml`. Version bump 0.6.1 → 0.6.2 everywhere. |
| [**0.6.1**](changelog/v0.6.1.md) | 2026-04-15 | **Binding validation** |
| [**0.6.0**](changelog/v0.6.0.md) | 2026-04-15 | **Skills & safety polish.** |
| [**0.5.9**](changelog/v0.5.9.md) | 2026-04-15 | **Audit CI gate + pre-commit hook** |
| [**0.5.8**](changelog/v0.5.8.md) | 2026-04-15 | **Canonical L/R margin 20px → 15px** |
| [**0.5.7**](docs/archive/changelog/v0.5.7.md) | 2026-04-15 | **Skill content rewrite to 100% coverage** |
| [**0.5.6**](changelog/v0.5.6.md) | 2026-04-15 | **Skills plumbing & coverage audit** |
| [**0.5.5**](docs/archive/changelog/v0.5.5.md) | 2026-04-15 | Slicer **multi-select** support — new `multiSelect` param on `add_visual` writes `objects.selection.singleSelect`, and `get_visual` slim mode now surfaces `slicerMode` + `multiSelect` for all slicer types (with PBI-default fallback). Applies to `slicer` and `listSlicer`. **`reload_report` moved to `DEFAULT_TOOLS`** — the on-demand `load_tools` mechanism activates server-side but most LLM harnesses snapshot the MCP catalog at session start, so a lazy `reload_report` could be activated but never invoked. Defaulting closes the trap. |
| [**0.5.4**](changelog/v0.5.4.md) | 2026-04-14 | Usage dashboard: **Calc Groups** tab (TMDL + BIM parser, per-item DAX expressions, precedence), **Tables tab** (PK/FK/relationship rendering, inferred PK detection), **light mode** with toggle and localStorage persistence, **KPI tooltips**, **copy-DAX button** on code blocks, **HIDDEN badge** for tooltip/drillthrough pages, dark-mode readability bump. **Wireframe validator** (`src/wireframe-validator.ts`) — pure function that catches out-of-bounds, overlaps, wrong margins/gaps, silent (0,0) defaults, rounding overflow, and the new **6px bottom margin** rule. **Shape text** — `createVisual.ts` now emits labels into the `objects.text` branch (was silently ignored via `general.paragraphs`), with friendly font names, bold/italic/underline, alignment, padding. **Skill rewrites** (`skills/shapes.md` v2.0 + `skills/wireframes.md` v2.0) matching the canonical constants, and a Python builder for the 5-page wireframe test report |
| [**0.5.3**](docs/archive/changelog/v0.5.3.md) | 2026-04-13 | Usage dashboard: three-tier field classification, UDF functions tab, conditional formatting detection, native folder picker, standalone web app |
| [**0.5.2**](docs/archive/changelog/v0.5.2.md) | 2026-04-12 | Bookmarks unparked (4 tools), `set_page_background`, `guide` knowledge layer (SVG visuals + report design topics) |
| [**0.5.1**](changelog/v0.5.1.md) | 2026-04-11 | New `model_usage` tool — cross-references semantic model with report, HTML dashboard, standalone CLI, cache invalidation |
| [**0.5.0**](docs/archive/changelog/v0.5.0.md) | 2026-04-09 | 5 new tools (sort, interactions, filter pane, extension measures, theme audit), format auto-routing, tooltip/drillthrough pages, advanced filters, wireframes doc, doc versioning |
| [**0.4.9**](docs/archive/changelog/v0.4.9.md) | 2026-04-08 | Smart tool loading (10 default / 37 on-demand), `load_tools` meta-tool, ARCHITECTURE.md, CONTRIBUTING.md, pbir-gotchas, visual-types, quickstart, sample report |
| [**0.4.8**](docs/archive/changelog/v0.4.8.md) | 2026-04-07 | Fix B12 gradient conditional format, B13 transparency property, B14 visual calculations (parked) |
| [**0.4.7**](docs/archive/changelog/v0.4.7.md) | 2026-04-07 | Fix B06 report settings allowlist, B07 relativeDate filter, B08 conditional format aggregation, B09 datapoint color selectors, B10 stackedBarChart naming |
| [**0.4.6**](docs/archive/changelog/v0.4.6.md) | 2026-04-06 | Fix B04 TopN subquery + `howCreated`, B05 TopN visual-level scope |
| [**0.4.5**](docs/archive/changelog/v0.4.5.md) | 2026-04-05 | Fix B01-B04 filter formats, boolean coercion, array preprocessing, Aggregation FieldRef |
| [**0.4.4**](docs/archive/changelog/v0.4.4.md) | 2026-04-05 | Image, actionButton, pageNavigator visual support |
| [**0.4.3**](docs/archive/changelog/v0.4.3.md) | 2026-04-05 | Bulk operations (delete, format, bind), visual calculations (parked) |
| [**0.4.2**](docs/archive/changelog/v0.4.2.md) | 2026-04-05 | `get_page_summary`, slim modes for get_visual/list_filters |
| [**0.4.1**](docs/archive/changelog/v0.4.1.md) | 2026-04-05 | Slim modes for list_pages/list_visuals, token usage guide |
| [**0.4.0**](docs/archive/changelog/v0.4.0.md) | 2026-04-04 | Page visibility, conditional formatting, bookmarks, diff_report_theme |
| [**0.3.1**](docs/archive/changelog/v0.3.1.md) | 2026-04-03 | Filters, themes, slicers, StaticResources helpers |
| [**0.3.0**](docs/archive/changelog/v0.3.0.md) | 2026-04-03 | Modular refactor, Table[Column] shorthand, safe() wrapper, 40-type visual reference |
