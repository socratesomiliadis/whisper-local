import { useState } from "react";
import {
    AudioLines,
    ArrowUpFromLine,
    FileAudio,
    Mic,
    Pause,
    Square,
    RotateCcw,
    RotateCw,
    X,
    LoaderCircle,
    ArrowRight,
    Download,
} from "lucide-react";
import { AdvancedSettings } from "./advanced-settings";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { stages } from "@/hooks/use-workspace";
import {
    Action,
    Field,
    PrefSelect,
    Disclosure,
    WorkspaceSelect,
} from "./workspace-controls";

const audioTypes =
    ".mp3,.wav,.m4a,.flac,.ogg,.opus,.webm,.aac,.mp4,.wma,.aiff,.aif";
const languages = [
    ["", "Detect automatically"],
    ["en", "English"],
    ["el", "Greek"],
    ["es", "Spanish"],
    ["fr", "French"],
    ["de", "German"],
    ["it", "Italian"],
    ["pt", "Portuguese"],
    ["nl", "Dutch"],
    ["ru", "Russian"],
    ["uk", "Ukrainian"],
    ["tr", "Turkish"],
    ["ar", "Arabic"],
    ["he", "Hebrew"],
    ["hi", "Hindi"],
    ["zh", "Chinese"],
    ["ja", "Japanese"],
    ["ko", "Korean"],
];

export function AudioPanel({ workspace: w }) {
    const [dragging, setDragging] = useState(false);
    const locked = w.busy || w.recording;
    const pending = w.queue.filter((entry) => entry.state === "queued").length;
    const disabled =
        locked ||
        w.setupBusy ||
        !w.ready ||
        !!w.activeJob ||
        (!w.file && !pending) ||
        (w.prefs["detect-speakers"] && !w.speakers.ready);
    return (
        <section
            className="min-w-0 rounded-3xl bg-card p-5 sm:p-6"
            aria-labelledby="audio-heading"
        >
            <div className="mb-5 flex items-center gap-2.5">
                <span
                    aria-hidden="true"
                    className="flex size-6 items-center justify-center rounded-full bg-muted text-[11px] font-medium text-muted-foreground"
                >
                    01
                </span>
                <h2
                    id="audio-heading"
                    className="text-base font-medium tracking-tight"
                >
                    Your audio
                </h2>
            </div>
            <input
                id="file"
                type="file"
                accept={audioTypes}
                multiple
                hidden
                disabled={locked}
                onChange={(event) => {
                    w.run("chooseFiles", Array.from(event.target.files));
                    event.target.value = "";
                }}
            />
            <button
                id="dropzone"
                type="button"
                aria-label="Choose an audio file"
                aria-disabled={locked}
                disabled={locked}
                className={cn(
                    "group/upload flex w-full flex-col items-center gap-2 rounded-2xl bg-background px-4 py-7 text-center transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring disabled:cursor-default disabled:opacity-50",
                    dragging && "bg-accent ring-2 ring-ring/40",
                )}
                onClick={() => document.getElementById("file").click()}
                onDragOver={(event) => {
                    event.preventDefault();
                    if (!locked) setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(event) => {
                    event.preventDefault();
                    setDragging(false);
                    w.run("chooseFiles", Array.from(event.dataTransfer.files));
                }}
            >
                <span className="mb-2 flex size-11 -rotate-6 items-center justify-center rounded-xl bg-[#fff0c2] text-[#8c6b26] ring-[3px] ring-card transition-transform group-hover/upload:rotate-0">
                    {w.file ? (
                        <FileAudio aria-hidden="true" className="size-5" />
                    ) : (
                        <ArrowUpFromLine
                            aria-hidden="true"
                            className="size-5"
                        />
                    )}
                </span>
                <strong
                    id="file-title"
                    className="max-w-full truncate text-sm font-medium"
                >
                    {w.file?.name || "Choose or drop audio"}
                </strong>
                <span
                    id="file-detail"
                    className="text-xs text-muted-foreground"
                >
                    {w.file
                        ? `${(w.file.size / 1024 / 1024).toFixed(1)} MB · Click to add more`
                        : "Select one or several recordings"}
                </span>
                <span className="mt-1 text-xs text-muted-foreground">
                    MP3, WAV, M4A and more · Up to 500 MB
                </span>
            </button>
            <Disclosure title="Record audio" icon={Mic} className="mt-3">
                <div className="flex flex-wrap gap-2">
                    <Action id="record-start">
                        <Mic />
                        Record
                    </Action>
                    <Action id="record-pause">
                        <Pause />
                        <span data-label>Pause</span>
                    </Action>
                    <Action id="record-stop">
                        <Square />
                        Stop &amp; preview
                    </Action>
                    <Action id="record-discard" variant="ghost">
                        Discard
                    </Action>
                </div>
                <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                    <span
                        id="recording-time"
                        className="font-mono tabular-nums"
                    >
                        0:00
                    </span>
                    <span className="mx-2">·</span>
                    <span id="recording-status" role="status">
                        Ready to record.
                    </span>
                </p>
            </Disclosure>
            <audio
                id="audio-player"
                className="mt-3 w-full"
                controls
                hidden={!w.file}
                aria-label="Preview selected audio"
            />
            <div
                id="waveform-panel"
                hidden
                className="mt-4 rounded-xl bg-background p-3"
            >
                <canvas
                    id="waveform"
                    height="72"
                    className="h-18 w-full rounded-md focus-visible:outline-2 focus-visible:outline-ring"
                />
                <p
                    id="waveform-status"
                    className="mt-2 text-xs leading-relaxed text-muted-foreground"
                    role="status"
                />
                <Disclosure title="Playback and audio range" className="mt-1">
                    <div className="grid grid-cols-2 gap-3">
                        <Field id="range-start" label="Start (seconds)">
                            <Input
                                id="range-start"
                                type="number"
                                min="0"
                                step="0.01"
                                defaultValue="0"
                            />
                        </Field>
                        <Field id="range-end" label="End (seconds)">
                            <Input
                                id="range-end"
                                type="number"
                                min="0"
                                step="0.01"
                                placeholder="Full recording"
                            />
                        </Field>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                        <Action
                            id="skip-back"
                            aria-label="Skip back 10 seconds"
                            size="sm"
                        >
                            <RotateCcw />
                            10s
                        </Action>
                        <Action
                            id="skip-forward"
                            aria-label="Skip forward 10 seconds"
                            size="sm"
                        >
                            10s
                            <RotateCw />
                        </Action>
                        <WorkspaceSelect
                            id="playback-speed"
                            aria-label="Playback speed"
                            value={w.prefs["playback-speed"]}
                            className="h-9 rounded-full px-3"
                            onValueChange={(value) =>
                                w.run("setPref", "playback-speed", value)
                            }
                            options={[
                                "0.5",
                                "0.75",
                                "1",
                                "1.25",
                                "1.5",
                                "2",
                            ].map((value) => [value, `${value}×`])}
                        />
                        <Action
                            id="range-reset"
                            variant="ghost"
                            className="ml-auto"
                            size="sm"
                        >
                            Reset
                        </Action>
                    </div>
                </Disclosure>
            </div>
            <div className="mt-5 grid gap-4">
                <PrefSelect
                    workspace={w}
                    id="quality"
                    label="Quality"
                    options={[
                        ["fast", "Fast · quick draft"],
                        ["balanced", "Balanced · everyday use"],
                        ["accurate", "Accurate · best results"],
                    ]}
                    disabled={locked}
                />
                <PrefSelect
                    workspace={w}
                    id="language"
                    label="Language"
                    options={languages}
                    disabled={locked}
                />
            </div>
            <AdvancedSettings workspace={w} />
            <Action
                id="transcribe"
                variant="default"
                className="mt-5 h-12 w-full rounded-full px-5 disabled:opacity-35"
                disabled={disabled}
                onClick={() => w.run("transcribe")}
            >
                {w.busy ? (
                    <LoaderCircle className="animate-spin" />
                ) : (
                    <AudioLines />
                )}
                {w.busy
                    ? "Transcribing…"
                    : pending > 1
                      ? `Transcribe ${pending} recordings`
                      : "Transcribe audio"}
                {!w.busy ? <ArrowRight className="ml-auto" /> : null}
            </Action>
            <div
                id="status"
                role="status"
                aria-live="polite"
                className={cn(
                    "mt-3 text-xs leading-relaxed text-muted-foreground",
                    w.messageType === "error" &&
                        "rounded-lg bg-destructive/5 p-3 text-destructive",
                    w.messageType === "success" && "text-primary",
                )}
            >
                {w.message}
            </div>
            <div
                id="job-progress"
                hidden={!w.progress}
                className="mt-4 space-y-3"
            >
                <div className="flex items-center justify-between text-xs">
                    <span id="progress-stage">
                        {stages[w.progress?.stage || w.progress?.state] ||
                            "Processing"}
                    </span>
                    <span id="progress-percent">
                        {typeof w.progress?.progress === "number"
                            ? `${Math.round(w.progress.progress * 100)}%`
                            : ""}
                    </span>
                </div>
                <progress
                    id="progress-bar"
                    className="h-1.5 w-full overflow-hidden rounded-full"
                    max="1"
                    value={
                        typeof w.progress?.progress === "number"
                            ? w.progress.progress
                            : undefined
                    }
                    aria-label="Current processing stage"
                />
                <Action
                    id="cancel-job"
                    disabled={!w.activeJob}
                    onClick={() => w.run("cancel")}
                    className="w-full"
                >
                    Cancel transcription
                </Action>
            </div>
            <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
                Models download on first use. After that, transcription works
                offline.
            </p>
            <section
                id="queue-panel"
                hidden={!w.queue.length}
                className="mt-5 rounded-2xl bg-background p-3"
                aria-labelledby="queue-heading"
            >
                <div className="mb-2 flex items-center justify-between">
                    <h3 id="queue-heading" className="text-sm font-medium">
                        Recordings{" "}
                        <span className="ml-1 text-muted-foreground">
                            {w.queue.length}
                        </span>
                    </h3>
                    <Action
                        id="clear-queue"
                        variant="ghost"
                        size="sm"
                        onClick={() => w.run("clearQueue")}
                    >
                        Clear finished
                    </Action>
                </div>
                <ol id="queue-list" className="space-y-1">
                    {w.queue.map((entry) => (
                        <li
                            key={entry.id}
                            className={cn(
                                "library-item flex min-w-0 items-center gap-2 rounded-lg px-2 py-1",
                                entry.id === w.selectedId &&
                                    "selected bg-accent",
                            )}
                        >
                            <button
                                type="button"
                                className="item-open min-w-0 flex-1 truncate py-2 text-left text-sm focus-visible:outline-ring"
                                disabled={locked}
                                onClick={() => w.run("selectEntry", entry)}
                                title={entry.file?.name}
                            >
                                {entry.file?.name || entry.name}
                            </button>
                            <span
                                title={entry.error}
                                className={cn(
                                    "item-state text-xs text-muted-foreground",
                                    entry.state,
                                    entry.state === "complete" &&
                                        "text-primary",
                                    entry.state === "error" &&
                                        "text-destructive",
                                )}
                            >
                                {entry.state}
                            </span>
                            <Action
                                variant="ghost"
                                size="icon-sm"
                                className="shrink-0 px-0"
                                aria-label={`Remove ${entry.name} from queue`}
                                disabled={locked}
                                onClick={() => w.run("removeEntry", entry.id)}
                            >
                                <X />
                            </Action>
                        </li>
                    ))}
                </ol>
                <div className="mt-3 flex flex-wrap gap-2">
                    <Action
                        id="stop-queue"
                        hidden={!w.busy || !pending}
                        onClick={() => w.run("stopQueue")}
                    >
                        Stop after current
                    </Action>
                    <Action
                        id="download-batch"
                        className="w-full"
                        disabled={!w.queue.some((entry) => entry.result)}
                        onClick={() => w.run("exportBatch")}
                    >
                        <Download />
                        Download all results (.zip)
                    </Action>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                    Files run one at a time. Keep this tab open.
                </p>
            </section>
        </section>
    );
}
