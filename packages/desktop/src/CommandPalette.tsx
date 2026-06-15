/**
 * CommandPalette (Cmd/Ctrl+K) — fast keyboard navigation across tables + common
 * actions. Built on the cmdk-based `command.tsx` primitive (inside a focus-
 * trapped Dialog): cmdk provides arrow-key list movement, fuzzy filtering, and
 * Enter-to-run; the Dialog provides Escape-to-close and focus restore.
 *
 * Purely presentational — App.tsx owns the open state and supplies the table
 * list + action callbacks, so the palette reuses the app's existing handlers
 * rather than reimplementing navigation.
 */

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "./components/ui/command";

export type PaletteTable = { id: string; name: string; kind: "local" | "cloud" };

export type PaletteAction = {
  id: string;
  label: string;
  /** Extra terms to match against (cmdk filters on text content). */
  keywords?: string;
  run: () => void;
};

export function CommandPalette({
  open,
  onOpenChange,
  tables,
  onSelectTable,
  actions,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tables: PaletteTable[];
  onSelectTable: (id: string, kind: "local" | "cloud") => void;
  actions: PaletteAction[];
}) {
  const close = () => onOpenChange(false);
  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Search tables and actions…" />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        {actions.length > 0 && (
          <CommandGroup heading="Actions">
            {actions.map((a) => (
              <CommandItem
                key={a.id}
                value={`${a.label} ${a.keywords ?? ""}`}
                onSelect={() => {
                  close();
                  a.run();
                }}
              >
                {a.label}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {tables.length > 0 && (
          <CommandGroup heading="Tables">
            {tables.map((t) => (
              <CommandItem
                key={`${t.kind}:${t.id}`}
                value={`table ${t.name}`}
                onSelect={() => {
                  close();
                  onSelectTable(t.id, t.kind);
                }}
              >
                {t.name}
                <span style={{ marginLeft: "auto", opacity: 0.5, fontSize: 11 }}>
                  {t.kind}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}
