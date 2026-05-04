# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
yarn dev                # local dev server (next dev)
yarn build              # production build (sets BUILD_MODE=true; enables Notion rate limiter)
yarn start              # serve the built output
yarn export             # full static export + sitemap (BUILD_MODE=true EXPORT=true)
yarn bundle-report      # build with @next/bundle-analyzer
yarn build-all-in-dev   # production build using local env (skips BUILD_MODE flag)

yarn lint               # next lint
yarn lint:fix           # next lint --fix
yarn type-check         # tsc --noEmit (parts of lib/ and lib/site are TS)
yarn format             # prettier write
yarn quality            # node scripts/quality-check.js (composite check)
yarn pre-commit         # lint:fix + format + type-check

yarn test               # jest
yarn test -- path/to/file.test.js       # run a single test file
yarn test -- -t "name"                  # run tests by name pattern
yarn test:watch         # watch mode
yarn test:coverage      # with coverage

yarn health-check       # node scripts/health-check.js
yarn dev-tools          # interactive maintenance tool (init / clean / docs / check-updates)
```

## Architecture

NotionNext is a Next.js 14 **Pages Router** SSG blog whose content lives in a Notion database. At build time, every article becomes its own static page; at runtime, pages can be revalidated via ISR (`NEXT_REVALIDATE_SECOND`).

### Configuration model

`blog.config.js` is the single source of truth. Every setting follows the pattern `process.env.X || <default>` so values can be overridden via Vercel/`.env` without code changes. `NOTION_PAGE_ID` accepts a multilang form `<id>,<lang>:<id>,…` (e.g. `abc,en:def`); `next.config.js` parses this at startup to build the supported `locales` list, and `lib/utils/pageId.js` (`extractLangId`/`extractLangPrefix`) is what splits each entry.

### Theme system

Themes live under `themes/<name>/` (each is self-contained: `index.js`, `config.js`, `style.js`, `components/`). The active theme is selected by `BLOG.THEME` and resolved at **build time** via a webpack alias in `next.config.js`:

```
@theme-components  →  themes/<THEME>
```

So `import * as ThemeComponents from '@theme-components'` resolves statically. `themes/theme.js` additionally supports per-request theme switching by `?theme=` query param (dynamic import). `next.config.js` scans `themes/` and exposes the list via `publicRuntimeConfig.THEMES`.

### Routing

Pages Router in `pages/`. The article catch-all is `pages/[prefix]/[slug]/[...suffix].js` (multilang prefix support). Other routes you'll touch often: `pages/index.js` (home), `pages/page/[page].js`, `pages/category/`, `pages/tag/`, `pages/archive/`, `pages/search/`. `pages/_app.js` conditionally wraps everything in `<ClerkProvider>` only when `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` is set; do NOT make this dynamic-imported (SSG needs the provider available synchronously, otherwise hooks like `useUser()` in `lib/global.js` crash with `Cannot destructure property 'auth' of 'e'`).

### Data layer

The data path is:

```
pages/* (getStaticProps/Paths) → lib/db/SiteDataApi.js → lib/db/notion/* → notion-client → Notion HTTP API
```

- **`lib/db/SiteDataApi.js`** — orchestrator. `fetchGlobalAllData` (site-wide), `getSiteDataByPageId`, `convertNotionToSiteData` (raw recordMap → normalized site shape with `allPages`, `categoryOptions`, `tagOptions`, `siteInfo`, `NOTION_CONFIG`, etc.), `resolvePostProps` (single-article fallback resolver used by the catch-all route), and the `EmptyData(pageId)` placeholder returned on any failure. Comments mark a planned migration to the `lib/site/` module — see below.
- **`lib/db/notion/getNotionAPI.js`** — wraps `notion-client`'s `NotionAPI` with three concerns: a global singleton, in-flight request dedup, and an optional `RateLimiter` (active only when `BUILD_MODE` or `EXPORT` env is set, i.e. production builds). It also contains a **`getPageWithCollectionRows`** patch (see "Notion API gotchas" below) that compensates for notion-client@7.7.1 not understanding Notion's newer response shape.
- **`lib/db/notion/getPostBlocks.js`** — `fetchNotionPageBlocks` with retry + cache, plus `fetchInBatches` for missing block ids and `formatNotionBlock` for code-block / file-url normalization.
- **`lib/db/notion/getNotionConfig.js`** — extracts a CONFIG-typed page (post.type === `CONFIG`/`config`/`Config`) and reads its embedded database into `NOTION_CONFIG`, which is merged on top of `blog.config.js` at runtime via `siteConfig()` from `lib/config`.
- **`lib/db/notion/normalizeUtil.js`** + **`lib/utils/notion.util.js#adapterNotionBlockMap`** — handle the new vs. old Notion response wrap (`block.value` vs `block.value.value`). All readers downstream of `adapterNotionBlockMap` assume the unwrapped shape.
- **`lib/cache/`** — pluggable cache backends (memory / local file / Redis) behind `cache_manager.js`.
- **`lib/site/`** — newer (still TS) abstraction layer for site data via `site.api.ts` / `site.service.ts` / `adapters/notion/*`. The intent (per the TODO at the top of `SiteDataApi.js`) is to migrate the data layer to a REST-like API surface; for now both coexist.

### Notion API gotchas (load-bearing details — read before changing data layer)

1. **Notion response shape changed.** Each block entry is now `{ spaceId, value: { value: <actual block>, role } }` rather than the old `{ value: <actual block> }`. `notion-client@7.7.1` and `notion-utils@7.7.1` were not updated for this — internally `getBlockCollectionId`, `getPageContentBlockIds`, and the `fetchCollections` loop in `getPage` all read `block.value.<field>` and silently see `undefined`. The pinned versions in `package.json` are intentional; do not bump them without re-validating the patch in `getNotionAPI.js`.
2. **`getPage()` does not populate `collection_query`** for the same reason — the patch in `getPageWithCollectionRows` calls `notion.getCollectionData(collectionId, viewId, view, {limit:999})` for each `collection_view_page` / `collection_view` reachable from the **root** via `block.content[]`, then merges the rows back into `recordMap.collection_query`. The BFS-from-root scope is deliberate: iterating *all* blocks pulls breadcrumbs of parent databases when rendering individual articles, which both wastes API calls and triggers rate-limit-induced malformed records.
3. **`adapterNotionBlockMap` filters blocks whose unwrapped value lacks `.id`.** This is defensive: react-notion-x's `Block` component crashes at `uuidToId(block.id)` on undefined ids, and concurrent SSG builds occasionally produce such partial blocks. Dropped entries fall through to react-notion-x's "missing block" warning + null render path.
4. **Rate limiting only kicks in during build** (`BUILD_MODE`/`EXPORT`). `lib/db/notion/RateLimiter.ts` enforces 200 req/min with a 300ms minimum gap and uses a `.notion-api-lock` file to coordinate between Next.js build workers.
5. **`SiteDataApi.EmptyData` is the universal fallback** — anything thrown inside `convertNotionToSiteData` ends up here. The placeholder post must be a string id (not a number) and must include `blockMap: { block: {} }`, otherwise downstream `idToUuid()` calls in `resolvePostProps` blow up with `id.slice/split is not a function`.

### Global UI state

`lib/global.js` exports `GlobalContextProvider` (used in `_app.js`) and `useGlobal()`. Lang/theme/dark-mode/Clerk-user state lives there. The `useUser()` call is gated by the same `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` check used in `_app.js` — keep them in sync if you touch one.

### Multi-language

The two pieces are: (a) `NOTION_PAGE_ID` parsed in `next.config.js` to derive locales, and (b) the `[prefix]` segment in `pages/[prefix]/...` carrying the language code. `lib/utils/lang.js` (`generateLocaleDict`, `initLocale`, `redirectUserLang`) maps prefix → strings.
