import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
    NativeSelect,
    NativeSelectOption,
} from "@/components/ui/native-select";
import { cn } from "@/lib/utils";

export function Action({ className, variant = "outline", ...props }) {
    return (
        <Button
            type="button"
            variant={variant}
            className={cn("h-9 gap-2 px-3 max-sm:min-h-11", className)}
            {...props}
        />
    );
}
export function Field({ label, id, children, hint }) {
    return (
        <div className="grid min-w-0 gap-2">
            <label className="text-sm font-medium" htmlFor={id}>
                {label}
            </label>
            {children}
            {hint ? (
                <p className="text-xs leading-relaxed text-muted-foreground">
                    {hint}
                </p>
            ) : null}
        </div>
    );
}
export function PrefSelect({
    workspace: w,
    id,
    label,
    options,
    disabled,
    hint,
}) {
    return (
        <Field id={id} label={label} hint={hint}>
            <NativeSelect
                id={id}
                className="w-full [&_select]:h-10 [&_select]:bg-background"
                value={w.prefs[id]}
                disabled={disabled}
                onChange={(event) => w.run("setPref", id, event.target.value)}
            >
                {options.map(([value, text]) => (
                    <NativeSelectOption value={value} key={value}>
                        {text}
                    </NativeSelectOption>
                ))}
            </NativeSelect>
        </Field>
    );
}
export function PrefCheck({ workspace: w, id, children, disabled }) {
    return (
        <label className="flex min-h-8 cursor-pointer items-center gap-2.5 text-sm has-disabled:cursor-default has-disabled:opacity-50">
            <input
                id={id}
                type="checkbox"
                className="size-4 shrink-0 rounded accent-primary focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
                checked={w.prefs[id]}
                disabled={disabled}
                onChange={(event) => w.run("setPref", id, event.target.checked)}
            />
            {children}
        </label>
    );
}
export function PrefNumber({ workspace: w, id, label, ...props }) {
    return (
        <Field id={id} label={label}>
            <Input
                id={id}
                type="number"
                className="h-10"
                value={w.prefs[id]}
                onChange={(event) => w.run("setPref", id, event.target.value)}
                {...props}
            />
        </Field>
    );
}
export function Disclosure({
    title,
    icon: Icon,
    children,
    className,
    ...props
}) {
    return (
        <details className={cn("group/disclosure", className)} {...props}>
            <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-sm font-medium outline-none focus-visible:rounded-md focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                {Icon ? (
                    <Icon
                        className="size-4 text-muted-foreground"
                        aria-hidden="true"
                    />
                ) : null}
                {title}
                <ChevronDown
                    aria-hidden="true"
                    className="ml-auto size-4 text-muted-foreground transition-transform group-open/disclosure:rotate-180"
                />
            </summary>
            <div className="pt-2 pb-3">{children}</div>
        </details>
    );
}
