"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AnimatePresence,
  motion,
  useReducedMotion,
  type Variants,
} from "framer-motion";

/* ------------------------------------------------------------------ */
/*  Theme tokens                                                       */
/* ------------------------------------------------------------------ */

const COLOR = {
  bg: "#222831",
  surface: "#393E46",
  text: "#DFD0B8",
  muted: "#948979",
  emerald: "#34d399",
  teal: "#2dd4bf",
} as const;

/* ------------------------------------------------------------------ */
/*  Verification stages                                                */
/* ------------------------------------------------------------------ */

type StageStatus = "completed" | "current" | "upcoming";

interface Stage {
  label: string;
  messages: string[];
}

const STAGES: readonly Stage[] = [
  {
    label: "Wallet Connected",
    messages: ["Establishing secure connection...", "Verifying wallet signature..."],
  },
  {
    label: "Retrieving Human Passport Score",
    messages: ["Reading Human Passport...", "Checking Sybil resistance...", "Scoring uniqueness..."],
  },
  {
    label: "Running Flare Confidential Compute",
    messages: ["Running confidential computation...", "Inside Flare TEE enclave...", "Compute sealed securely..."],
  },
  {
    label: "Generating Zero-Knowledge Proof",
    messages: ["Generating zero-knowledge proof...", "Compiling proof circuit...", "Finalizing proof..."],
  },
  {
    label: "Submitting Verification",
    messages: ["Validating cryptographic proof...", "Submitting to Flare Coston2...", "Finalizing verification..."],
  },
  {
    label: "Unlocking Secure Messaging",
    messages: ["Unlocking encrypted messaging...", "Provisioning secure mailbox...", "Preparing your inbox..."],
  },
];

const LAST_STAGE_INDEX = STAGES.length - 1;
// Cinematic, premium pacing: each stage lingers long enough to read and feel
// intentional. The auto-advance timer per stage (>= 3s) and the per-message
// cycle (> 2s) ensure every step breathes before moving on.
const STAGE_DURATION_MS = 3200;
const MESSAGE_CYCLE_MS = 2200;
const SUCCESS_HOLD_MS = 1400;

/* ------------------------------------------------------------------ */
/*  Reusable animation variants                                        */
/* ------------------------------------------------------------------ */

const overlayVariants: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.35, ease: [0.16, 1, 0.3, 1] } },
  exit: { opacity: 0, transition: { duration: 0.6, ease: [0.16, 1, 0.3, 1] } },
};

const cardVariants: Variants = {
  initial: { opacity: 0, y: 24, scale: 0.96 },
  animate: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.5, ease: [0.16, 1, 0.3, 1] } },
};

const rowVariants: Variants = {
  initial: { opacity: 0, x: -10 },
  animate: { opacity: 1, x: 0, transition: { duration: 0.4, ease: [0.16, 1, 0.3, 1] } },
};

const successTextVariants: Variants = {
  initial: { opacity: 0, y: 12, scale: 0.96 },
  animate: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.5, ease: [0.16, 1, 0.3, 1] } },
};

/* ------------------------------------------------------------------ */
/*  Confetti — deterministic so it is stable across renders            */
/* ------------------------------------------------------------------ */

interface ConfettiParticle {
  dx: number;
  rise: number;
  fall: number;
  rotate: number;
  size: number;
  color: string;
  delay: number;
}

const CONFETTI_COLORS = [COLOR.emerald, COLOR.teal, "#5eead4", COLOR.text];

const CONFETTI: readonly ConfettiParticle[] = Array.from(
  { length: 34 },
  (_, i) => {
    const angle = (i / 34) * Math.PI * 2 + (i % 3) * 0.18;
    const velocity = 130 + (i % 5) * 28;
    const dx = Math.cos(angle) * velocity;
    const rise = -50 - (i % 4) * 28;
    const fall = 230 + (i % 3) * 55;
    return {
      dx,
      rise,
      fall,
      rotate: (i % 2 === 0 ? 1 : -1) * (160 + i * 22),
      size: 6 + (i % 4) * 2,
      color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
      delay: (i % 9) * 0.018,
    };
  },
);

/* ------------------------------------------------------------------ */
/*  Icons                                                              */
/* ------------------------------------------------------------------ */

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden>
      <path
        d="M16.7 5.3a1 1 0 010 1.4l-7.5 7.5a1 1 0 01-1.4 0L3.3 9.7a1 1 0 011.4-1.4l3.3 3.3 6.8-6.8a1 1 0 011.4 0z"
        fill="currentColor"
      />
    </svg>
  );
}

function SpinnerIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.18" strokeWidth="2.5" />
      <path
        d="M21 12a9 9 0 00-9-9"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function SuccessCheckmark({ reducedMotion }: { reducedMotion: boolean }) {
  return (
    <motion.svg
      viewBox="0 0 52 52"
      className="h-24 w-24"
      initial={{ scale: reducedMotion ? 1 : 0.6, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
      aria-hidden
    >
      <motion.circle
        cx="26"
        cy="26"
        r="24"
        fill="none"
        stroke={COLOR.emerald}
        strokeWidth="2.5"
        strokeLinecap="round"
        transform="rotate(-90 26 26)"
        initial={{ pathLength: 0, opacity: 0 }}
        animate={{ pathLength: 1, opacity: 1 }}
        transition={{ duration: reducedMotion ? 0.01 : 0.6, ease: [0.16, 1, 0.3, 1] }}
      />
      <motion.path
        d="M15 27l7 7 15-16"
        fill="none"
        stroke={COLOR.emerald}
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{
          duration: reducedMotion ? 0.01 : 0.45,
          delay: reducedMotion ? 0 : 0.35,
          ease: [0.16, 1, 0.3, 1],
        }}
      />
    </motion.svg>
  );
}

/* ------------------------------------------------------------------ */
/*  Stage row                                                          */
/* ------------------------------------------------------------------ */

interface StageRowProps {
  label: string;
  status: StageStatus;
  index: number;
  reducedMotion: boolean;
}

function StageRow({ label, status, index, reducedMotion }: StageRowProps) {
    const isCompleted = status === "completed";
    const isCurrent = status === "current";

    return (
      <motion.li
        variants={rowVariants}
        className="relative flex items-center gap-4 overflow-hidden rounded-2xl px-3 py-2.5 sm:px-4"
        transition={{ delay: index * 0.06 }}
      >
        {/* Moving shimmer for the current step */}
        {isCurrent && !reducedMotion && (
          <motion.span
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-2xl"
            style={{
              background:
                "linear-gradient(90deg, transparent 0%, rgba(223,208,184,0.07) 50%, transparent 100%)",
              backgroundSize: "200% 100%",
            }}
            animate={{ backgroundPosition: ["200% 0%", "-200% 0%"] }}
            transition={{ duration: 2.2, repeat: Infinity, ease: "easeInOut" }}
          />
        )}

        {/* Indicator */}
        <div className="relative flex h-9 w-9 shrink-0 items-center justify-center">
          <AnimatePresence mode="wait" initial={false}>
            {isCompleted ? (
              <motion.span
                key="completed"
                initial={{ scale: reducedMotion ? 1 : 0.4, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
                className="flex h-9 w-9 items-center justify-center rounded-full bg-emerald-400/15 text-emerald-300 ring-1 ring-emerald-400/40"
              >
                <motion.span
                  aria-hidden
                  className="absolute inset-0 rounded-full ring-1 ring-emerald-400/40"
                  initial={{ scale: reducedMotion ? 1 : 0.85, opacity: 0.6 }}
                  animate={{ scale: 1.35, opacity: 0 }}
                  transition={{ duration: 1.1, repeat: Infinity, ease: "easeOut" }}
                />
                <CheckIcon className="h-4 w-4" />
              </motion.span>
            ) : isCurrent ? (
              <motion.span
                key="current"
                initial={{ scale: 0.6, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.6, opacity: 0 }}
                transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
                className="relative flex h-9 w-9 items-center justify-center rounded-full bg-[#222831] text-[#DFD0B8] ring-1 ring-[#DFD0B8]/25"
              >
                {/* Breathing glow */}
                {!reducedMotion && (
                  <motion.span
                    aria-hidden
                    className="absolute inset-0 rounded-full ring-1 ring-[#DFD0B8]/30"
                    animate={{ opacity: [0.25, 0.7, 0.25], scale: [0.9, 1.08, 0.9] }}
                    transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }}
                  />
                )}
                <motion.span
                  animate={reducedMotion ? {} : { rotate: 360 }}
                  transition={{ duration: 1.1, repeat: Infinity, ease: "linear" }}
                >
                  <SpinnerIcon className="h-5 w-5" />
                </motion.span>
              </motion.span>
            ) : (
              <motion.span
                key="upcoming"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.3 }}
                className="flex h-9 w-9 items-center justify-center rounded-full border border-[#DFD0B8]/10 bg-[#222831]/40 text-[#948979]/70"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-[#948979]/50" />
              </motion.span>
            )}
          </AnimatePresence>
        </div>

        {/* Label */}
        <span
          className={`relative text-sm font-medium tracking-tight transition-colors duration-300 sm:text-[15px] ${
            isCompleted
              ? "text-emerald-200/90"
              : isCurrent
                ? "text-[#DFD0B8]"
                : "text-[#948979]/60"
          }`}
        >
          {label}
        </span>
      </motion.li>
  );
}

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

export interface VerificationLoaderProps {
  /** Index of the current stage (0–5). Auto-advances internally when omitted. */
  currentStep?: number;
  /** Gate the success sequence on real verification completion. */
  isSuccess: boolean;
  /** Fired after the success sequence finishes (after the 1s hold). */
  onComplete?: () => void;
}

export default function VerificationLoader({
  currentStep: controlledStep,
  isSuccess,
  onComplete,
}: VerificationLoaderProps) {
  const reducedMotion = useReducedMotion();
  const [internalStep, setInternalStep] = useState(
    Math.min(controlledStep ?? 0, LAST_STAGE_INDEX),
  );
  const [messageIndex, setMessageIndex] = useState(0);
  const [exiting, setExiting] = useState(false);
  const completedRef = useRef(false);

  /* Auto-advance through the stages until the last one, then hold. */
  useEffect(() => {
    if (isSuccess) return;
    if (internalStep >= LAST_STAGE_INDEX) return;

    const id = window.setTimeout(() => {
      setInternalStep((s) => Math.min(s + 1, LAST_STAGE_INDEX));
    }, STAGE_DURATION_MS);
    return () => window.clearTimeout(id);
  }, [internalStep, isSuccess]);

  /* Cycle the status message within the active stage. */
  useEffect(() => {
    if (isSuccess) return;
    const messages = STAGES[internalStep].messages;
    if (messages.length <= 1) return;

    const id = window.setInterval(() => {
      setMessageIndex((i) => (i + 1) % messages.length);
    }, MESSAGE_CYCLE_MS);
    return () => window.clearInterval(id);
  }, [internalStep, isSuccess]);

  /* Reset the message index whenever the stage changes. */
  useEffect(() => {
    setMessageIndex(0);
  }, [internalStep]);

  /* After the success hold, fade the overlay out, then fire onComplete. */
  useEffect(() => {
    if (!isSuccess || completedRef.current) return;
    completedRef.current = true;
    const id = window.setTimeout(() => {
      setExiting(true);
    }, SUCCESS_HOLD_MS);
    return () => window.clearTimeout(id);
  }, [isSuccess]);

  /* Derive per-stage status. On success everything is completed. */
  const stageStatuses = useMemo<StageStatus[]>(
    () =>
      STAGES.map((_, i) => {
        if (isSuccess) return "completed";
        if (i < internalStep) return "completed";
        if (i === internalStep) return "current";
        return "upcoming";
      }),
    [internalStep, isSuccess],
  );

  const progress = isSuccess
    ? 100
    : 8 + (internalStep / LAST_STAGE_INDEX) * 84;

  const ringColor = isSuccess
    ? "rgba(52,211,153,0.75)"
    : "rgba(223,208,184,0.5)";

  const statusMessage = isSuccess
    ? "Identity verified — secure messaging enabled"
    : STAGES[internalStep].messages[messageIndex % STAGES[internalStep].messages.length];

  const overlay = (
    <motion.div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6"
      style={{
        backgroundColor: "rgba(34, 40, 49, 0.72)",
        backdropFilter: "blur(16px)",
        WebkitBackdropFilter: "blur(16px)",
      }}
      variants={overlayVariants}
      initial="initial"
      animate="animate"
      exit="exit"
      role="dialog"
      aria-modal="true"
      aria-label="Verifying your identity"
    >
      {/* Layered ambient gradients */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(40rem 40rem at 50% -10%, rgba(52,211,153,0.07), transparent 60%), radial-gradient(34rem 34rem at 110% 110%, rgba(223,208,184,0.06), transparent 55%)",
        }}
      />

      <motion.div
        variants={cardVariants}
        initial="initial"
        animate="animate"
        className="relative w-full max-w-md overflow-hidden rounded-[28px] border border-[#DFD0B8]/10 bg-[#393E46]/80 p-6 shadow-2xl shadow-black/40 sm:p-8"
        style={{ willChange: "transform" }}
      >
        {/* Breathing glow behind the card */}
        <motion.div
          aria-hidden
          className="pointer-events-none absolute -inset-10 -z-10 rounded-[40px] blur-2xl"
          style={{
            background: isSuccess
              ? "radial-gradient(closest-side, rgba(52,211,153,0.22), transparent 70%)"
              : "radial-gradient(closest-side, rgba(223,208,184,0.12), transparent 70%)",
          }}
          animate={
            reducedMotion
              ? { opacity: 0.8 }
              : { opacity: [0.5, 0.85, 0.5], scale: [1, 1.04, 1] }
          }
          transition={{ duration: 3.6, repeat: Infinity, ease: "easeInOut" }}
        />

        {/* Animated glowing border ring */}
        <motion.div
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-[28px]"
          style={{
            padding: "1.5px",
            WebkitMask:
              "linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)",
            WebkitMaskComposite: "xor",
            maskComposite: "exclude",
            background: `conic-gradient(from 0deg, transparent 0%, ${ringColor} 50%, transparent 100%)`,
          }}
          animate={reducedMotion ? {} : { rotate: 360 }}
          transition={{ duration: 7, repeat: Infinity, ease: "linear" }}
        />

        <AnimatePresence mode="wait" initial={false}>
          {isSuccess ? (
            <motion.div
              key="success"
              variants={successTextVariants}
              initial="initial"
              animate="animate"
              className="relative flex flex-col items-center text-center"
            >
              {/* Confetti */}
              {!reducedMotion && (
                <div aria-hidden className="pointer-events-none absolute left-1/2 top-10 -translate-x-1/2">
                  {CONFETTI.map((p, i) => (
                    <motion.span
                      key={i}
                      className="absolute block rounded-[2px]"
                      style={{
                        width: p.size,
                        height: p.size * 1.4,
                        backgroundColor: p.color,
                      }}
                      initial={{ x: 0, y: 0, opacity: 1, rotate: 0, scale: 1 }}
                      animate={{
                        x: p.dx,
                        y: [0, p.rise, p.fall],
                        opacity: [1, 1, 0],
                        rotate: p.rotate,
                        scale: [1, 1, 0.7],
                      }}
                      transition={{
                        duration: 1.3,
                        delay: p.delay,
                        ease: "easeOut",
                        times: [0, 0.35, 1],
                      }}
                    />
                  ))}
                </div>
              )}

              <div className="relative mb-5 flex h-24 w-24 items-center justify-center">
                <SuccessCheckmark reducedMotion={Boolean(reducedMotion)} />
              </div>

              <h2 className="text-2xl font-bold tracking-tight text-emerald-200 sm:text-3xl">
                IDENTITY VERIFIED
              </h2>
              <p className="mt-2 text-sm font-medium text-[#DFD0B8]/80">
                Secure Messaging Enabled
              </p>
            </motion.div>
          ) : (
            <motion.div
              key="progress"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
              className="relative"
            >
              {/* Header */}
              <div className="mb-6 text-center">
                <h2 className="text-xl font-bold tracking-tight text-[#DFD0B8] sm:text-2xl">
                  Verifying your identity
                </h2>
                <p className="mt-2 text-sm leading-relaxed text-[#948979]">
                  Running privacy-preserving checks inside Flare Confidential
                  Compute.
                </p>
              </div>

              {/* Timeline */}
              <motion.ol
                variants={{ animate: { transition: { staggerChildren: 0.07 } } }}
                initial="initial"
                animate="animate"
                className="flex flex-col gap-1.5"
              >
                {STAGES.map((stage, i) => (
                  <StageRow
                    key={stage.label}
                    label={stage.label}
                    status={stageStatuses[i]}
                    index={i}
                    reducedMotion={Boolean(reducedMotion)}
                  />
                ))}
              </motion.ol>

              {/* Progress bar */}
              <div className="mt-6">
                <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-[#222831]">
                  <motion.div
                    className="h-full rounded-full"
                    style={{
                      background: isSuccess
                        ? "linear-gradient(90deg, #34d399, #2dd4bf)"
                        : "linear-gradient(90deg, #948979, #dfd0b8)",
                      boxShadow: isSuccess
                        ? "0 0 12px rgba(52,211,153,0.5)"
                        : "0 0 10px rgba(223,208,184,0.25)",
                    }}
                    initial={{ width: "8%" }}
                    animate={{ width: `${progress}%` }}
                    transition={{
                      duration: reducedMotion ? 0.2 : 0.7,
                      ease: [0.16, 1, 0.3, 1],
                    }}
                  />
                </div>

                {/* Cycling status message */}
                <div className="mt-3 flex items-center justify-center">
                  <span className="sr-only">Status: </span>
                  <AnimatePresence mode="wait" initial={false}>
                    <motion.span
                      key={statusMessage}
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -6 }}
                      transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
                      className="h-5 text-center text-xs font-medium tracking-wide text-[#948979]"
                      aria-live="polite"
                    >
                      {statusMessage}
                    </motion.span>
                  </AnimatePresence>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </motion.div>
  );

  return (
    <AnimatePresence onExitComplete={() => onComplete?.()}>
      {!exiting && overlay}
    </AnimatePresence>
  );
}

export { STAGES as VERIFICATION_STAGES };