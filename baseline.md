# baseline rules

- prisma is pinned to v6.x (predictable schema + migrate)
- do not use `pnpm dlx prisma` (it runs latest prisma cli and breaks schema expectations)
- use `pnpm exec prisma ...` or `pnpm prisma ...`
- prisma loads `.env` by default; next.js uses `.env.local`
  - keep in sync with: `cp .env.local .env`
- vercel env is source-of-truth:
  - after changing env vars in vercel: `vercel env pull .env.local`