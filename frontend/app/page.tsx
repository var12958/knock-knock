import Link from "next/link";

export default function Home() {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-brand-100 text-4xl">
        🚪
      </div>
      <h1 className="mb-4 text-4xl font-bold text-slate-800">KnockKnock</h1>
      <p className="mb-8 max-w-md text-lg text-slate-600">
        Privacy-first Web3 messaging on the Flare Coston2 testnet.
      </p>

      <div className="flex gap-4">
        <Link
          href="/send"
          className="rounded-lg bg-brand-600 px-6 py-3 font-semibold text-white shadow transition hover:bg-brand-700"
        >
          Send a Knock
        </Link>
        <Link
          href="/inbox"
          className="rounded-lg border border-slate-300 bg-white px-6 py-3 font-semibold text-slate-700 transition hover:bg-slate-50"
        >
          Open Inbox
        </Link>
      </div>
    </div>
  );
}
