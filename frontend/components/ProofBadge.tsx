interface ProofBadgeProps {
  label: string;
  active: boolean;
}

export default function ProofBadge({ label, active }: ProofBadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${
        active
          ? "bg-green-100 text-green-700"
          : "bg-slate-100 text-slate-500"
      }`}
    >
      <span className="text-sm">{active ? "✅" : "➖"}</span>
      {label}
    </span>
  );
}
