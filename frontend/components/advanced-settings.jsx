import {
    Download,
    LoaderCircle,
    Zap,
    SlidersHorizontal,
    ChevronRight,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import {
    Dialog,
    DialogTrigger,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogFooter,
    DialogClose,
} from "@/components/ui/dialog";
import {
    Action,
    Field,
    PrefSelect,
    PrefCheck,
    PrefNumber,
} from "./workspace-controls";

export function AdvancedSettings({ workspace: w }) {
    const locked = w.busy || w.recording;
    return (
        <Dialog
            open={w.advancedOpen}
            onOpenChange={(open) => w.run("setAdvancedOpen", open)}
        >
            <DialogTrigger
                id="advanced-settings"
                render={
                    <Action
                        variant="ghost"
                        className="mt-4 w-full justify-start border-y rounded-none px-0"
                    />
                }
            >
                <SlidersHorizontal />
                Advanced settings
                <ChevronRight className="ml-auto" />
            </DialogTrigger>
            <DialogContent
                keepMounted
                className="flex max-h-[calc(100svh_-_2rem)] max-w-[calc(100vw_-_2rem)] flex-col sm:max-w-lg"
            >
                <DialogHeader>
                    <DialogTitle>Advanced settings</DialogTitle>
                    <DialogDescription>
                        Adjust the model, processing, and speaker detection.
                    </DialogDescription>
                </DialogHeader>
                <div className="min-h-0 overflow-y-auto p-1">
                    <div className="grid gap-4">
                        <PrefSelect
                            workspace={w}
                            id="model"
                            label="Whisper model"
                            options={[
                                ["tiny", "Tiny · fastest"],
                                ["base", "Base · balanced"],
                                ["small", "Small · more accurate"],
                            ]}
                            disabled={locked}
                        />
                        <PrefSelect
                            workspace={w}
                            id="processing"
                            label="Processing"
                            options={[
                                ["auto", "Automatic · use GPU if available"],
                                ["cpu", "CPU only"],
                            ]}
                            disabled={locked}
                        />
                        <p
                            id="acceleration"
                            className="text-xs text-muted-foreground"
                            role="status"
                        >
                            {w.acceleration}
                        </p>
                        <Action
                            id="fast-mode"
                            disabled={locked}
                            onClick={() => w.run("fastMode")}
                            className="justify-start"
                        >
                            <Zap />
                            Use fast mode
                        </Action>
                        <div className="border-t pt-3">
                            <PrefCheck
                                workspace={w}
                                id="detect-speakers"
                                disabled={locked}
                            >
                                Detect speakers
                            </PrefCheck>
                            <p className="mt-1 text-xs text-muted-foreground">
                                Label different voices. Adds processing time.
                            </p>
                        </div>
                        <div
                            id="speaker-options"
                            hidden={!w.prefs["detect-speakers"]}
                            className="space-y-4"
                        >
                            <PrefNumber
                                workspace={w}
                                id="speaker-count"
                                label="Number of speakers (optional)"
                                min="1"
                                max="20"
                                step="1"
                                placeholder="Detect automatically"
                                disabled={w.busy || !w.prefs["detect-speakers"]}
                            />
                            <div
                                id="speaker-setup"
                                hidden={w.speakers.ready}
                                className="space-y-3 rounded-lg bg-muted/50 p-3"
                            >
                                <p className="text-sm font-medium">
                                    Set up speaker detection
                                </p>
                                <p className="text-xs leading-relaxed text-muted-foreground">
                                    Accept the{" "}
                                    <a
                                        className="underline underline-offset-2"
                                        href="https://huggingface.co/pyannote/speaker-diarization-community-1"
                                        target="_blank"
                                        rel="noreferrer"
                                    >
                                        model’s terms on Hugging Face
                                    </a>
                                    , which include sharing contact details.
                                    Then create a{" "}
                                    <a
                                        className="underline underline-offset-2"
                                        href="https://huggingface.co/settings/tokens"
                                        target="_blank"
                                        rel="noreferrer"
                                    >
                                        token with read access
                                    </a>
                                    .
                                </p>
                                <Field
                                    id="hf-token"
                                    label="Hugging Face download token"
                                >
                                    <Input
                                        id="hf-token"
                                        type="password"
                                        autoComplete="off"
                                        spellCheck={false}
                                        maxLength={500}
                                        placeholder="hf_…"
                                        disabled={w.busy || w.setupBusy}
                                    />
                                </Field>
                                <Action
                                    id="setup-speakers"
                                    className="w-full"
                                    disabled={
                                        w.busy ||
                                        w.setupBusy ||
                                        !w.speakers.installed
                                    }
                                    onClick={() => w.run("setupSpeakers")}
                                >
                                    {w.setupBusy ? (
                                        <LoaderCircle className="animate-spin" />
                                    ) : (
                                        <Download />
                                    )}
                                    {w.setupBusy
                                        ? "Downloading…"
                                        : "Download speaker model"}
                                </Action>
                                <p className="text-xs text-muted-foreground">
                                    Used for this download only. Never saved.
                                </p>
                            </div>
                            <p
                                id="speaker-status"
                                role="status"
                                className="text-xs leading-relaxed text-muted-foreground"
                            >
                                {w.speakerMessage}
                            </p>
                        </div>
                    </div>
                </div>
                <DialogFooter className="shrink-0">
                    <DialogClose render={<Action variant="default" />}>
                        Done
                    </DialogClose>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
