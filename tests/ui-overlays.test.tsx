import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button } from "@/components/ui/Button";
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/Command";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/DropdownMenu";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/Sheet";
import { Tooltip, TooltipProvider } from "@/components/ui/Tooltip";

const html = (node: ReactElement) => renderToStaticMarkup(node);

describe("ConfirmDialog", () => {
  it("renders only its trigger until opened, announced as opening a dialog", () => {
    const markup = html(
      <ConfirmDialog trigger={<Button>Remove</Button>} title="Remove this member?" description="They lose access." confirmLabel="Remove member" formId="remove" />
    );
    expect(markup).toContain('aria-haspopup="dialog"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain("Remove this member?");
  });
});

describe("DropdownMenu", () => {
  it("marks its trigger as opening a menu", () => {
    const markup = html(
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="secondary">Workspaces</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Founding</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
    expect(markup).toContain('aria-haspopup="menu"');
    expect(markup).not.toContain("Founding");
  });
});

describe("Sheet", () => {
  it("marks its trigger as opening a dialog", () => {
    const markup = html(
      <Sheet>
        <SheetTrigger asChild>
          <Button size="icon" aria-label="Open navigation">
            <svg />
          </Button>
        </SheetTrigger>
        <SheetContent side="left" title="Navigation">
          Links
        </SheetContent>
      </Sheet>
    );
    expect(markup).toContain('aria-haspopup="dialog"');
    expect(markup).toContain('aria-label="Open navigation"');
  });
});

describe("Tooltip", () => {
  it("wraps its trigger and renders the tip only on demand", () => {
    const markup = html(
      <TooltipProvider>
        <Tooltip content="Copy the transaction hash">
          <Button size="icon-sm" aria-label="Copy">
            <svg />
          </Button>
        </Tooltip>
      </TooltipProvider>
    );
    expect(markup).toContain('aria-label="Copy"');
    expect(markup).not.toContain("Copy the transaction hash");
  });
});

describe("Command", () => {
  it("renders a searchable list of its items", () => {
    const markup = html(
      <Command label="Jump to">
        <CommandInput placeholder="Search" />
        <CommandList>
          <CommandGroup heading="Sections">
            <CommandItem>Treasury</CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    );
    expect(markup).toContain('role="combobox"');
    expect(markup).toContain("Treasury");
  });
});
