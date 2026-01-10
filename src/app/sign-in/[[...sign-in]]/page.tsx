import { SignIn } from "@clerk/nextjs";

export default function Page() {
  return (
    <main className="min-h-screen grid place-items-center p-6">
      <SignIn />
    </main>
  );
}

