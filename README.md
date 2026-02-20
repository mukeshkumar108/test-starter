# nextstarter

A reusable Next.js starter with:
- next.js (app router)
- clerk auth (protected `/app/*`)
- neon postgres via vercel storage
- prisma (pinned v6) + migrations
- user table mapped to clerk user
- vercel blob storage (with test route)
- tailwind + shadcn-ready setup

## quickstart (new project)

### 1) create a new repo from this template (github)
click **use this template**.

### 2) install + link vercel
```bash
pnpm install
vercel link
```

### 3) create storage in vercel
vercel dashboard → project → storage:
- create neon postgres
- create blob

### 4) pull env
```bash
vercel env pull .env.local
cp .env.local .env
```

### 5) migrate
```bash
pnpm exec prisma migrate dev
```

### 6) run
```bash
pnpm dev
```

## routes

- /app/settings → proves clerk + db mapping
- POST /api/blob-test → uploads a test blob and returns a public url

## baseline rules

see `baseline.md`

## notes
- Next.js 16 uses proxy.ts (replaces middleware.ts).

## overlays (Sophie)
Overlay prompts live in `prompts/overlays/`. They are injected as temporary system lenses when deterministic heuristics trigger:
- `curiosity_spiral.md`: story‑pulling curiosity (max once per session, up to 4 turns)
- `accountability_tug.md`: gentle open‑loop check‑in (max once per day, 48h backoff on dismissal)

Tune triggers and cooldowns in `src/lib/services/memory/overlaySelector.ts`.

## prompt stack (Sophie)
Current `/api/chat` model-facing order:
1. persona (compiled kernels)
2. conversation posture
3. overlay (optional)
4. startbrief bridge (optional)
5. startbrief handover (optional, verbatim)
6. ops snippet (optional)
7. supplemental recall sheet (optional)
8. recent session messages
9. current user message

Session orientation now comes from startbrief-v2 only (`bridge` + `handover`).

## environment validation
Env is validated at boot in `src/env.ts`. Add new variables there and to `.env.example`.

## prisma pooled vs direct connections
Use pooled URL for app runtime (`POSTGRES_PRISMA_URL`) and direct URL for migrations (`POSTGRES_URL_NON_POOLING`).

## clerk webhook user provisioning
`user.created` is handled by `POST /api/webhooks/clerk` to upsert the DB user.
