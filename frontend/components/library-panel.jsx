import { useState } from "react";
import { FileText, Trash2, FolderOpen } from "lucide-react";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogFooter,
    DialogClose,
} from "@/components/ui/dialog";
import { Action, PrefCheck, Disclosure } from "./workspace-controls";

export function LibraryPanel({ workspace: w }) {
    const [confirm, setConfirm] = useState(false);
    return (
        <section
            className="mt-5 rounded-3xl bg-card p-5 sm:p-6"
            aria-labelledby="history-heading"
        >
            <div className="flex flex-wrap items-center justify-between gap-2">
                <h2
                    id="history-heading"
                    className="flex items-center gap-2.5 text-base font-medium tracking-tight"
                >
                    <FolderOpen
                        aria-hidden="true"
                        className="size-4 text-muted-foreground"
                    />
                    Saved transcripts
                </h2>
                <div className="flex items-center gap-2">
                    <span
                        id="history-status"
                        role="status"
                        className="text-xs text-muted-foreground"
                    >
                        {w.historyMessage}
                    </span>
                    <Action
                        id="clear-history"
                        variant="ghost"
                        size="sm"
                        disabled={w.busy || !w.records.length}
                        onClick={() => setConfirm(true)}
                    >
                        <Trash2 />
                        Delete all
                    </Action>
                </div>
            </div>
            <Disclosure title="Storage preferences" className="mt-2">
                <div className="flex flex-wrap gap-x-6 gap-y-2">
                    <PrefCheck workspace={w} id="save-history">
                        Save transcripts in this browser
                    </PrefCheck>
                    <PrefCheck workspace={w} id="retain-audio">
                        Keep audio for playback
                    </PrefCheck>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                    Saved on this computer, in this browser. Export a copy to
                    keep it elsewhere.
                </p>
            </Disclosure>
            <p
                id="history-empty"
                hidden={!!w.records.length}
                className="mt-2 rounded-2xl bg-background px-4 py-4 text-sm leading-relaxed text-muted-foreground"
            >
                {w.prefs["save-history"]
                    ? "No saved transcripts yet. Completed transcripts save here automatically."
                    : "No saved transcripts. Automatic saving is off."}
            </p>
            <ul id="history-list" className="space-y-2">
                {w.records.map((record) => (
                    <li
                        key={record.id}
                        className="library-item flex min-w-0 items-center gap-3 rounded-2xl bg-background px-3 py-3"
                    >
                        <FileText
                            aria-hidden="true"
                            className="size-5 shrink-0 text-muted-foreground"
                        />
                        <button
                            type="button"
                            className="item-open grid min-w-0 flex-1 gap-1 text-left outline-none focus-visible:rounded focus-visible:ring-2 focus-visible:ring-ring"
                            disabled={w.busy || w.recording}
                            onClick={() => w.run("openRecord", record.id)}
                        >
                            <strong className="truncate text-sm font-medium">
                                {record.name}
                            </strong>
                            <small className="text-xs text-muted-foreground">
                                {new Date(record.updated).toLocaleString()} ·{" "}
                                {record.result.language?.toUpperCase() ||
                                    "Auto"}{" "}
                                ·{" "}
                                {record.audio
                                    ? "Audio retained"
                                    : "Transcript only"}
                            </small>
                        </button>
                        <Action
                            variant="ghost"
                            size="icon"
                            aria-label={`Delete saved transcript ${record.name}`}
                            disabled={w.busy}
                            onClick={() => w.run("deleteRecord", record.id)}
                        >
                            <Trash2 />
                        </Action>
                    </li>
                ))}
            </ul>
            <Dialog open={confirm} onOpenChange={setConfirm}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Delete all saved transcripts?</DialogTitle>
                        <DialogDescription>
                            This removes transcripts and retained audio from
                            this browser. Download any copies you want to keep
                            first.
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <DialogClose render={<Action />}>
                            Keep transcripts
                        </DialogClose>
                        <Action
                            variant="destructive"
                            disabled={w.busy}
                            onClick={() => {
                                w.run("clearHistory");
                                setConfirm(false);
                            }}
                        >
                            Delete saved transcripts
                        </Action>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </section>
    );
}
