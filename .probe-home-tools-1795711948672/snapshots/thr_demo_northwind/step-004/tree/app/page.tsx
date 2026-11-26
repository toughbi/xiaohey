import { SummaryRow } from '@/components/summary-row';
import { ExceptionTable } from '@/components/exception-table';

export default function Page() {
  return (
    <main className="mx-auto max-w-6xl p-8">
      <header className="mb-10 flex items-center justify-between">
        <div>
          <h1 className="bg-gradient-to-r from-violet-400 to-fuchsia-300 bg-clip-text text-4xl font-extrabold text-transparent">
            Welcome back, Damir! 👋
          </h1>
          <p className="mt-2 text-slate-400">Your AI-powered reconciliation workspace ✨</p>
        </div>
        <button className="rounded-full bg-violet-600 px-6 py-3 font-semibold shadow-[0_0_40px_rgba(139,92,246,0.55)]">
          New import 🚀
        </button>
      </header>

      <section className="grid grid-cols-3 gap-6">
        <SummaryRow label="MATCHED" value="1,284" tone="emerald" />
        <SummaryRow label="EXCEPTIONS" value="37" tone="amber" />
        <SummaryRow label="VALUE AT RISK" value="$48,210.40" tone="rose" />
      </section>

      <ExceptionTable rows={[]} />
    </main>
  );
}
