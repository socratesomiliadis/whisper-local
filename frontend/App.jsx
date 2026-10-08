import { AudioLines, LockKeyhole } from "lucide-react";
import { AudioPanel } from "@/components/audio-panel";
import { TranscriptPanel } from "@/components/transcript-panel";
import { LibraryPanel } from "@/components/library-panel";
import { useWorkspace } from "@/hooks/use-workspace";
import { ThemeSwitcher } from "@/components/theme-switcher";

export default function App() {
    const workspace = useWorkspace();
    return (
        <div className="min-h-screen bg-background">
            <header>
                <div className="mx-auto flex h-24 max-w-[78rem] items-center justify-between gap-4 px-5 sm:px-8">
                    <a
                        href="/"
                        className="inline-flex items-center gap-2.5 rounded-full px-4 py-1.5 outline-none transition-colors bg-foreground text-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4"
                        aria-label="Whisper Local home"
                    >
                        <AudioLines
                            aria-hidden="true"
                            className="size-5"
                            strokeWidth={2.5}
                        />
                        <span className="text-xl font-bold tracking-[-0.06em]">
                            Whisper <span className="font-medium">Local</span>
                        </span>
                    </a>
                    <div className="flex items-center gap-2 sm:gap-3">
                        <span
                            className="flex size-10 items-center justify-center gap-2 rounded-full bg-muted text-muted-foreground sm:w-auto sm:px-3.5 sm:text-sm"
                            title="Audio stays on your computer. Temporary uploads are deleted after processing."
                            aria-label="Local & private"
                        >
                            <LockKeyhole
                                aria-hidden="true"
                                className="size-3.5"
                            />
                            <span className="hidden sm:inline">
                                Local &amp; private
                            </span>
                        </span>
                        <ThemeSwitcher />
                    </div>
                </div>
            </header>
            <main
                id="workspace"
                className="mx-auto max-w-[78rem] px-5 pb-8 pt-6 sm:px-8 sm:pt-9"
            >
                <div className="mb-9 flex flex-wrap items-end justify-between gap-5 sm:mb-10">
                    <div>
                        <h1 className="text-[clamp(2rem,4.4vw,3.25rem)] font-medium leading-[1.25] tracking-[-0.055em]">
                            Turn{" "}
                            <span className="inline-flex items-center gap-2 rounded-full bg-muted px-3.5 pb-1 align-middle sm:gap-2.5 sm:px-4">
                                <span className="inline-flex size-8 -rotate-12 items-center justify-center rounded-[10px] bg-blue-100 text-blue-600 ring-[3px] ring-card dark:bg-blue-400/15 dark:text-blue-300 sm:size-10">
                                    <AudioLines
                                        aria-hidden="true"
                                        className="size-5 sm:size-6"
                                        strokeWidth={2}
                                    />
                                </span>
                                audio
                            </span>{" "}
                            into words.
                        </h1>
                    </div>
                </div>
                <div className="grid items-stretch gap-5 lg:grid-cols-[352px_minmax(0,1fr)]">
                    <AudioPanel workspace={workspace} />
                    <TranscriptPanel workspace={workspace} />
                </div>
                <LibraryPanel workspace={workspace} />
                <footer className="mt-6 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-1 text-xs leading-relaxed text-muted-foreground">
                    <span>Powered by WhisperX</span>
                </footer>
            </main>
        </div>
    );
}
