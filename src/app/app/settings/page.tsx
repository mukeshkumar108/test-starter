import { currentUser } from "@clerk/nextjs/server";
import { getUserByClerkId } from "@/lib/user";

export default async function SettingsPage() {
  const cu = await currentUser();
  if (!cu) return null; // middleware/proxy should protect

  const email = cu.emailAddresses?.[0]?.emailAddress ?? null;
  const dbUser = await getUserByClerkId(cu.id);

  return (
    <main className="min-h-screen p-6">
      <div className="max-w-xl space-y-4">
        <h1 className="text-2xl font-semibold">settings</h1>

        {dbUser ? (
          <div className="rounded-lg border p-4 space-y-2">
            <div><b>clerk id:</b> {cu.id}</div>
            <div><b>email:</b> {email ?? "—"}</div>
            <div><b>db id:</b> {dbUser.id}</div>
            <div><b>created:</b> {dbUser.createdAt.toISOString()}</div>
          </div>
        ) : (
          <div className="rounded-lg border p-4">
            user not yet provisioned
          </div>
        )}

        <p className="text-muted-foreground">
          clerk + postgres + prisma wired.
        </p>
      </div>
    </main>
  );
}
