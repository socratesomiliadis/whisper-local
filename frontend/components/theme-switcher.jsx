import { Monitor, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuTrigger,
    DropdownMenuContent,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu";
import { useTheme } from "@/hooks/use-theme";

const themes = [
    { value: "light", label: "Light", icon: Sun },
    { value: "dark", label: "Dark", icon: Moon },
    { value: "system", label: "System", icon: Monitor },
];

export function ThemeSwitcher() {
    const { theme, setTheme } = useTheme();
    const selected = themes.find((option) => option.value === theme);
    const Icon = selected.icon;
    return (
        <DropdownMenu>
            <DropdownMenuTrigger
                aria-label={`Theme: ${selected.label}`}
                title="Change theme"
                render={
                    <Button
                        variant="ghost"
                        size="icon"
                        className="size-10 rounded-full bg-muted"
                    />
                }
            >
                <Icon aria-hidden="true" className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
                align="end"
                sideOffset={8}
                className="min-w-40 rounded-2xl p-1.5 motion-reduce:animate-none"
            >
                <DropdownMenuRadioGroup
                    aria-label="Theme"
                    value={theme}
                    onValueChange={setTheme}
                >
                    {themes.map(({ value, label, icon: OptionIcon }) => (
                        <DropdownMenuRadioItem
                            key={value}
                            value={value}
                            closeOnClick
                            className="min-h-10 gap-2.5 rounded-xl px-3"
                        >
                            <OptionIcon
                                aria-hidden="true"
                                className="size-4 text-muted-foreground"
                            />
                            {label}
                        </DropdownMenuRadioItem>
                    ))}
                </DropdownMenuRadioGroup>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
