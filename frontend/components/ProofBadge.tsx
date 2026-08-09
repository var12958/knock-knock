interface ProofBadgeProps {
  label: string;
  active: boolean;
  /**
   * Visual variant. `twitter` renders the blue verified badge (bird/checkmark)
   * for FDC-verified Twitter handles; `default` renders the standard proof pill.
   */
  variant?: "default" | "twitter";
}

export default function ProofBadge({
  label,
  active,
  variant = "default",
}: ProofBadgeProps) {
  if (variant === "twitter") {
    return (
      <span
        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-bold transition-colors duration-200 ${
          active
            ? "border-sky-400/40 bg-sky-500/15 text-sky-300"
            : "border-[#948979]/20 bg-[#393E46]/60 text-[#948979]"
        }`}
        title={
          active
            ? "Twitter handle verified via Flare Data Connector"
            : "Twitter not verified"
        }
      >
        {active ? (
          // Official-style verified checkmark
          <svg
            viewBox="0 0 24 24"
            fill="currentColor"
            className="h-3.5 w-3.5"
            aria-hidden
          >
            <path d="M22.25 12c0-1.43-.88-2.67-2.19-3.34.46-1.39.2-2.9-.81-3.91s-2.52-1.27-3.91-.81c-.66-1.31-1.91-2.19-3.34-2.19s-2.67.88-3.33 2.19c-1.4-.46-2.91-.2-3.92.81s-1.26 2.52-.8 3.91c-1.31.67-2.2 1.91-2.2 3.34s.89 2.67 2.2 3.34c-.46 1.39-.21 2.9.8 3.91s2.52 1.26 3.91.81c.67 1.31 1.91 2.19 3.34 2.19s2.68-.88 3.34-2.19c1.39.45 2.9.2 3.91-.81s1.27-2.52.81-3.91c1.31-.67 2.19-1.91 2.19-3.34zm-11.71 4.2L6.8 12.46l1.41-1.42 2.26 2.26 4.8-5.23 1.47 1.36-6.2 6.77z" />
          </svg>
        ) : (
          <span className="text-sm">🐦</span>
        )}
        {label}
      </span>
    );
  }

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