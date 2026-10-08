import { AudioLines, LockKeyhole } from "lucide-react";
import { AudioPanel } from "@/components/audio-panel";
import { TranscriptPanel } from "@/components/transcript-panel";
import { LibraryPanel } from "@/components/library-panel";
import { useWorkspace } from "@/hooks/use-workspace";

export default function App() {
    const workspace = useWorkspace();
    return (
        <div className="min-h-screen bg-background">
            <header className="border-b bg-card">
                <div className="mx-auto flex h-18 max-w-6xl items-center justify-between gap-4 px-5 sm:px-8">
                    <a
                        href="/"
                        className="flex items-center gap-3 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        aria-label="Whisper Local home"
                    >
                        <span className="flex size-9 items-center justify-center rounded-xl bg-primary text-primary-foreground">
                            <AudioLines aria-hidden="true" className="size-5" />
                        </span>
                        <span className="text-base font-semibold tracking-tight">
                            Whisper{" "}
                            <span className="font-normal text-muted-foreground">
                                Local
                            </span>
                        </span>
                    </a>
                    <span className="flex items-center gap-2 text-xs text-muted-foreground">
                        <LockKeyhole aria-hidden="true" className="size-3.5" />
                        Runs on your computer
                    </span>
                </div>
            </header>
            <main className="mx-auto max-w-6xl px-5 py-8 sm:px-8 sm:py-10">
                <div className="mb-7">
                    <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
                        Transcribe audio
                    </h1>
                    <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                        Turn recordings into text you can edit, copy, and
                        export.
                    </p>
                </div>
                <div className="grid items-stretch gap-6 lg:grid-cols-[360px_minmax(0,1fr)]">
                    <AudioPanel workspace={workspace} />
                    <TranscriptPanel workspace={workspace} />
                </div>
                <LibraryPanel workspace={workspace} />
                <footer className="mt-6 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 text-xs leading-relaxed text-muted-foreground">
                    <span>
                        Audio stays local. Temporary uploads are deleted after
                        processing.
                    </span>
                    <span>Powered by WhisperX</span>
                </footer>
            </main>
        </div>
    );
}
