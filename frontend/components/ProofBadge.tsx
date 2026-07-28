interface ProofBadgeProps {
  label: string;
  active: boolean;
}

export default function ProofBadge({ label, active }: ProofBadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-bold ${
        active
          ? "border-[#DFD0B8]/20 bg-[#222831] text-[#DFD0B8]"
          : "border-[#948979]/20 bg-[#393E46]/60 text-[#948979]"
      }`}
    >
      <span className="text-sm">{active ? "✅" : "➖"}</span>
      {label}
    </span>
  );
}
