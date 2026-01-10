import Link from "next/link";
import { SignedIn, SignedOut, UserButton } from "@clerk/nextjs";

export default function Home() {
  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-md space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">talkly</h1>
          <SignedIn><UserButton /></SignedIn>
        </div>

        <p className="text-muted-foreground">
          hold to talk. stt → llm → tts.
        </p>

        <SignedOut>
          <div className="flex gap-3">
            <Link className="px-4 py-2 rounded-md border" href="/sign-in">
              sign in
            </Link>
            <Link className="px-4 py-2 rounded-md bg-black text-white" href="/sign-up">
              sign up
            </Link>
          </div>
        </SignedOut>

        <SignedIn>
          <Link className="inline-flex px-4 py-2 rounded-md bg-black text-white" href="/app">
            go to app
          </Link>
        </SignedIn>
      </div>
    </main>
  );
}
