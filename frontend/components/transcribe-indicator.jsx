import { AudioLines } from "lucide-react";
import { ThinkingOrb } from "thinking-orbs";
import { cn } from "@/lib/utils";
import { useTheme } from "@/hooks/use-theme";

const transition =
    "absolute inset-0 flex items-center justify-center transition-[opacity,filter,scale] duration-400 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none";

export function TranscribeIndicator({ active, stage, paused }) {
    const { resolvedTheme } = useTheme();
    return (
        <span aria-hidden="true" className="relative size-5 shrink-0">
            <span
                className={cn(
                    transition,
                    active
                        ? "scale-75 opacity-0 blur-[4px]"
                        : "scale-100 opacity-100 blur-none",
                )}
            >
                <AudioLines className="size-4" />
            </span>
            <span
                data-slot="transcribe-orb"
                data-active={active ? "" : undefined}
                className={cn(
                    transition,
                    active
                        ? "scale-100 opacity-100 blur-none"
                        : "scale-125 opacity-0 blur-[4px]",
                )}
            >
                <ThinkingOrb
                    size={20}
                    state={stage === "transcribing" ? "composing" : "working"}
                    theme={resolvedTheme === "dark" ? "light" : "dark"}
                    paused={!active || paused}
                    aria-hidden="true"
                />
            </span>
        </span>
    );
}
