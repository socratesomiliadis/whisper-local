import {
    Undo2,
    Redo2,
    FileAudio,
    Search,
    ChevronLeft,
    ChevronRight,
    Plus,
    Check,
    Copy,
    Download,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { BotAvatar } from "bot-avatars";
import { useEffectPreferences } from "@/hooks/use-effects";
import { useTheme } from "@/hooks/use-theme";
import { createPortal } from "react-dom";
import {
    Action,
    PrefCheck,
    PrefNumber,
    Disclosure,
    WorkspaceSelect,
} from "./workspace-controls";

const audioTypes =
    ".mp3,.wav,.m4a,.flac,.ogg,.opus,.webm,.aac,.mp4,.wma,.aiff,.aif";

export function TranscriptPanel({ workspace: w }) {
    const { resolvedTheme } = useTheme();
    const { visible, reducedMotion } = useEffectPreferences();
    return (
        <section
            className="flex min-w-0 flex-col overflow-hidden rounded-3xl bg-card"
            aria-labelledby="transcript-heading"
        >
            <div className="flex min-h-18 items-center justify-between gap-3 bg-background/60 px-5 sm:px-6">
                <div className="flex min-w-0 items-center gap-2.5">
                    <span
                        aria-hidden="true"
                        className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium text-muted-foreground"
                    >
                        02
                    </span>
                    <h2
                        id="transcript-heading"
                        className="truncate text-base font-medium tracking-tight"
                    >
                        {w.result ? w.resultName : "Transcript"}
                    </h2>
                </div>
            </div>
            <div
                id="empty"
                hidden={w.result}
                className="flex min-h-95 flex-1 flex-col items-center justify-center px-6 py-12 text-center lg:min-h-125"
            >
                <div className="mb-7 flex size-24 items-center justify-center">
                    <BotAvatar
                        theme={resolvedTheme}
                        type="cat"
                        shading="crisp"
                        glasses="round"
                        size={96}
                        state={w.busy ? "working" : "default"}
                        paused={!visible || reducedMotion || w.result}
                        data-slot="transcript-avatar"
                        aria-label={
                            w.busy
                                ? "Whisper bot, working"
                                : "Whisper bot, ready"
                        }
                    />
                </div>
                <h3
                    hidden={w.busy}
                    className="text-base font-medium tracking-tight text-muted-foreground"
                >
                    Your transcript will appear here
                </h3>
            </div>
            <div id="results" hidden={!w.result} className="p-5 sm:p-6">
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <span
                        id="result-meta"
                        className="text-xs text-muted-foreground"
                    />
                    <div
                        className="view-toggle flex rounded-full bg-muted p-1"
                        role="group"
                        aria-label="Transcript view"
                    >
                        <Action
                            id="plain-view"
                            variant="ghost"
                            className="h-7 px-3 text-xs"
                            aria-pressed="false"
                        >
                            Text
                        </Action>
                        <Action
                            id="timed-view"
                            variant="ghost"
                            className="selected h-7 px-3 text-xs"
                            aria-pressed="true"
                        >
                            Timestamps
                        </Action>
                    </div>
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-2">
                    <Action id="undo-edit" variant="ghost" size="sm">
                        <Undo2 />
                        Undo
                    </Action>
                    <Action id="redo-edit" variant="ghost" size="sm">
                        <Redo2 />
                        Redo
                    </Action>
                    <div className="ml-auto">
                        <PrefCheck workspace={w} id="follow-playback">
                            Follow playback
                        </PrefCheck>
                    </div>
                </div>
                <input
                    id="attach-audio"
                    type="file"
                    accept={audioTypes}
                    hidden
                    onChange={(event) => {
                        w.run("attachAudio", event.target.files[0]);
                        event.target.value = "";
                    }}
                />
                <Action
                    id="attach-audio-label"
                    hidden={!!w.file}
                    disabled={w.busy || w.recording}
                    className="mt-3"
                    onClick={() =>
                        document.getElementById("attach-audio").click()
                    }
                >
                    <FileAudio />
                    Attach audio for playback
                </Action>
                <Disclosure
                    title="Find and replace"
                    icon={Search}
                    className="mt-3 rounded-xl bg-background px-3"
                >
                    <div className="flex flex-wrap items-center gap-2">
                        <Input
                            id="search-text"
                            type="search"
                            aria-label="Search transcript"
                            placeholder="Search transcript"
                            className="min-w-36 flex-1"
                        />
                        <Action
                            id="search-prev"
                            variant="ghost"
                            size="icon"
                            aria-label="Previous match"
                        >
                            <ChevronLeft />
                        </Action>
                        <Action
                            id="search-next"
                            variant="ghost"
                            size="icon"
                            aria-label="Next match"
                        >
                            <ChevronRight />
                        </Action>
                        <span
                            id="search-count"
                            aria-live="polite"
                            className="text-xs text-muted-foreground"
                        />
                    </div>
                    <div className="mt-2 flex gap-2">
                        <Input
                            id="replace-text"
                            aria-label="Replacement text"
                            placeholder="Replace with"
                            className="min-w-0 flex-1"
                        />
                        <Action id="replace-all">Replace all</Action>
                    </div>
                </Disclosure>
                <Disclosure title="Speaker names" className="mt-2">
                    <div id="speaker-names" hidden>
                        <div
                            id="speaker-name-fields"
                            className="grid gap-3 sm:grid-cols-2"
                        />
                    </div>
                    <Action id="add-speaker" variant="ghost" className="mt-2">
                        <Plus />
                        Add a speaker
                    </Action>
                </Disclosure>
                <textarea
                    id="transcript"
                    readOnly
                    aria-label="Transcript text"
                    spellCheck={false}
                    className="mt-3 min-h-80 w-full resize-y rounded-2xl bg-background p-4 text-sm leading-7 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                <div
                    id="segments"
                    hidden
                    className="mt-3 max-h-145 space-y-3 overflow-y-auto pr-1"
                />
                {w.speakerSelects.map(({ container, index, ...props }) =>
                    createPortal(
                        <WorkspaceSelect
                            {...props}
                            aria-label={`Speaker for segment ${index + 1}`}
                            data-editor-focus={`speaker-${index}`}
                            className="h-8 w-full bg-card px-2 text-xs hover:bg-card/70"
                        />,
                        container,
                        String(index),
                    ),
                )}
                <div className="mt-5 flex flex-wrap items-center gap-2 pt-4">
                    <Action id="copy" onClick={() => w.run("copy")}>
                        {w.copied ? <Check /> : <Copy />}
                        {w.copied ? "Copied" : "Copy text"}
                    </Action>
                    <Action
                        id="save-txt"
                        variant="default"
                        onClick={() => w.run("exportFile", "txt")}
                    >
                        <Download />
                        Save text
                    </Action>
                    <Action
                        id="save-srt"
                        variant="ghost"
                        onClick={() => w.run("exportFile", "srt")}
                    >
                        SRT
                    </Action>
                    <Action
                        id="save-vtt"
                        variant="ghost"
                        onClick={() => w.run("exportFile", "vtt")}
                    >
                        VTT
                    </Action>
                    <Action
                        id="save-json"
                        variant="ghost"
                        onClick={() => w.run("exportFile", "json")}
                    >
                        JSON
                    </Action>
                </div>
                <Disclosure title="Subtitle export settings" className="mt-2">
                    <div className="grid grid-cols-2 gap-3">
                        <PrefNumber
                            workspace={w}
                            id="subtitle-line-length"
                            label="Characters per line"
                            min="10"
                            max="100"
                        />
                        <PrefNumber
                            workspace={w}
                            id="subtitle-duration"
                            label="Max cue seconds"
                            min="1"
                            max="30"
                            step="0.5"
                        />
                    </div>
                    <div className="mt-3">
                        <PrefCheck workspace={w} id="subtitle-speakers">
                            Include speaker names
                        </PrefCheck>
                    </div>
                </Disclosure>
            </div>
        </section>
    );
}
