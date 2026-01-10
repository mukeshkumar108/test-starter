import { UserButton } from "@clerk/nextjs";

export default function AppPage() {
  return (
    <main className="p-6">
      <div className="flex justify-end">
        <UserButton />
      </div>
      <h1 className="text-2xl font-semibold">Talkly</h1>
      <p className="text-muted-foreground">clerk auth works.</p>
    </main>
  );
}
