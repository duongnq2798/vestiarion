"use client";

import { AnimatePresence, m } from "motion/react";
import {
  ChartLine,
  Check,
  ChevronsUpDown,
  FileText,
  Flag,
  Landmark,
  LogOut,
  Play,
  Plus,
  ScrollText,
  ShieldCheck,
  UserCog,
  Users,
} from "lucide-react";
import { useState } from "react";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/Card";
import { Checkbox } from "@/components/ui/Checkbox";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator, CommandShortcut } from "@/components/ui/Command";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { CopyButton } from "@/components/ui/CopyButton";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTrigger } from "@/components/ui/Dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/DropdownMenu";
import { Field } from "@/components/ui/Field";
import { FileInput } from "@/components/ui/FileInput";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input, Textarea } from "@/components/ui/Input";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/Select";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/Sheet";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/Table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { toast } from "@/components/ui/Toaster";
import { MOTION } from "@/components/ui/tokens";
import { useActionForm, type ActionResult } from "@/components/ui/useActionForm";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface LabState extends ActionResult {
  entries: Array<[string, string]>;
}

const LAB_INITIAL: LabState = { ok: false, message: "", entries: [] };

/** Stands in for a server action: it echoes what arrived, and refuses an amount that is not above zero. */
async function echo(_previous: LabState, formData: FormData): Promise<LabState> {
  await wait(700);
  const entries = [...formData.entries()].map(([key, value]): [string, string] => [key, typeof value === "string" ? value : `${value.name} · ${value.size} bytes`]);
  if (!(Number(formData.get("amount")) > 0)) {
    return { ok: false, message: "Amount must be above zero. Everything you typed is still in the form.", entries };
  }
  return { ok: true, message: `The action received ${entries.length} fields.`, entries };
}

/**
 * The check that every control reaches a server action: Radix’s select and
 * checkbox, the pressed button’s name and value, a chosen or dropped file. A
 * refusal must keep the fields; a success clears them.
 */
export function FormLab() {
  const { state, formProps } = useActionForm(echo, LAB_INITIAL, { resetOnSuccess: true, toastOnSuccess: true });
  const refused = !state.ok && state.message !== "";
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <form {...formProps} className="grid gap-4 rounded-2xl border border-line bg-surface p-5 shadow-surface sm:grid-cols-2 sm:p-6">
        <Field id="lab-name" label="Legal or trading name">
          <Input name="name" required autoComplete="organization" />
        </Field>
        <Field id="lab-role" label="Role">
          <Select name="role" defaultValue="vendor">
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="vendor">Vendor</SelectItem>
              <SelectItem value="contractor">Contractor</SelectItem>
              <SelectItem value="client">Client</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field id="lab-amount" label="Amount (USDC)" description="Enter 0 to see a refusal keep your input" error={refused ? "Enter an amount above zero" : undefined}>
          <Input name="amount" inputMode="decimal" placeholder="1250.00" />
        </Field>
        <Field id="lab-due" label="Due date">
          <Input name="dueDate" type="date" />
        </Field>
        <Field id="lab-memo" label="Memo" optional className="sm:col-span-2">
          <Textarea name="memo" rows={3} />
        </Field>
        <Checkbox name="goodsReceived" label="Goods or services received" description="Submits “on” when ticked, like a native checkbox" className="sm:col-span-2" />
        <div className="sm:col-span-2">
          <FileInput id="lab-file" name="attachment" accept=".csv,text/csv" label="Choose a CSV file, or drop one here" description="Nothing is uploaded until you submit" onFile={() => {}} />
        </div>
        <div className="flex flex-col gap-3 sm:col-span-2 sm:flex-row sm:items-center sm:justify-between">
          <FormMessage tone={state.message ? (state.ok ? "success" : "error") : "neutral"}>{state.message}</FormMessage>
          <div className="flex shrink-0 gap-2">
            <SubmitButton name="intent" value="draft" variant="secondary" pendingLabel="Saving…">
              Save draft
            </SubmitButton>
            <SubmitButton name="intent" value="submit" pendingLabel="Submitting…">
              Submit
            </SubmitButton>
          </div>
        </div>
      </form>
      <Card>
        <CardHeader>
          <CardTitle>What the action received</CardTitle>
          <CardDescription>The last submission’s FormData, field by field.</CardDescription>
        </CardHeader>
        <CardContent className="px-0 sm:px-0">
          {state.entries.length === 0 ? (
            <p className="px-5 text-sm text-ink-3 sm:px-6">Nothing submitted yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Value</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {state.entries.map(([key, value], index) => (
                  <TableRow key={`${key}-${index}`}>
                    <TableCell className="font-mono text-xs text-ink-2">{key}</TableCell>
                    <TableCell className="break-all">{value || "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

const PEOPLE = ["ada@example.com", "grace@example.com", "alan@example.com"];

/** A member list whose rows ask before removal and fade out once removed. */
function RemoveDemo() {
  const [people, setPeople] = useState(PEOPLE);
  return (
    <div className="space-y-3">
      <ul className="divide-y divide-line rounded-xl border border-line">
        <AnimatePresence initial={false}>
          {people.map((email) => (
            <m.li
              key={email}
              layout
              exit={{ opacity: 0, x: -12 }}
              transition={{ duration: MOTION.duration.exit, ease: MOTION.ease.exit }}
              className="flex items-center gap-3 px-3 py-2.5"
            >
              <PersonRow email={email} onRemoved={() => setPeople((list) => list.filter((person) => person !== email))} />
            </m.li>
          ))}
        </AnimatePresence>
      </ul>
      {people.length < PEOPLE.length && (
        <Button variant="link" onClick={() => setPeople(PEOPLE)}>
          Bring them back
        </Button>
      )}
    </div>
  );
}

const REMOVE_INITIAL: ActionResult = { ok: false, message: "" };

function PersonRow({ email, onRemoved }: { email: string; onRemoved: () => void }) {
  const formId = `remove-${email.replace(/[^a-z]/g, "")}`;
  const { pending, formProps } = useActionForm(
    async (_previous: ActionResult, formData: FormData): Promise<ActionResult> => {
      await wait(700);
      onRemoved();
      return { ok: true, message: `${String(formData.get("email"))} was removed.` };
    },
    REMOVE_INITIAL,
    { toastOnSuccess: true }
  );
  return (
    <form id={formId} {...formProps} className="flex min-w-0 flex-1 items-center gap-3">
      <input type="hidden" name="email" value={email} />
      <Avatar name={email} size="sm" />
      <span className="min-w-0 flex-1 truncate text-sm">{email}</span>
      <ConfirmDialog
        formId={formId}
        trigger={
          <Button variant="danger" size="sm" loading={pending}>
            Remove
          </Button>
        }
        title={`Remove ${email}?`}
        description="They lose access to this workspace at once. You can invite them again later."
        confirmLabel="Remove member"
      />
    </form>
  );
}

const SECTIONS = [
  { label: "Treasury", icon: Landmark, shortcut: "G T" },
  { label: "Insights", icon: ChartLine, shortcut: "G I" },
  { label: "AP / AR", icon: FileText, shortcut: "G P" },
  { label: "Counterparties", icon: Users, shortcut: "G C" },
  { label: "Contractors", icon: Flag, shortcut: "G K" },
  { label: "Compliance", icon: ShieldCheck, shortcut: "G S" },
  { label: "Audit log", icon: ScrollText, shortcut: "G A" },
  { label: "Members", icon: UserCog, shortcut: "G M" },
] as const;

export function OverlayDemo() {
  const [paletteOpen, setPaletteOpen] = useState(false);

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Dialog</CardTitle>
          <CardDescription>A modal panel with a required title. Escape, the close button or a click outside closes it.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="secondary" icon={<Plus />}>
                Add a counterparty
              </Button>
            </DialogTrigger>
            <DialogContent title="Add a counterparty" description="Screening runs as soon as it is saved.">
              <Field id="dialog-name" label="Legal or trading name">
                <Input name="name" autoComplete="organization" />
              </Field>
              <DialogFooter>
                <DialogClose asChild>
                  <Button variant="secondary">Cancel</Button>
                </DialogClose>
                <DialogClose asChild>
                  <Button>Add and screen</Button>
                </DialogClose>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="secondary">A long dialog</Button>
            </DialogTrigger>
            <DialogContent title="A long dialog">
              {Array.from({ length: 12 }, (_, index) => (
                <p key={index} className="text-sm leading-relaxed text-ink-2">
                  A modal panel with a required title. Escape, the close button or a click outside closes it.
                </p>
              ))}
            </DialogContent>
          </Dialog>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Confirmation, then presence</CardTitle>
          <CardDescription>Removal asks first; a removed row fades out and the list closes the gap.</CardDescription>
        </CardHeader>
        <CardContent>
          <RemoveDemo />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Sheet</CardTitle>
          <CardDescription>A panel from any edge — the navigation drawer is the left one.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {(["left", "right", "top", "bottom"] as const).map((side) => (
            <Sheet key={side}>
              <SheetTrigger asChild>
                <Button variant="secondary" size="sm" className="capitalize">
                  {side}
                </Button>
              </SheetTrigger>
              <SheetContent side={side} title={`A ${side} sheet`} description="Focus stays inside until it closes.">
                <div className="space-y-3 p-5 text-sm text-ink-2">
                  <p>Escape, the close button or a click on the dimmed page closes it, and focus returns to the button that opened it.</p>
                </div>
              </SheetContent>
            </Sheet>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Dropdown menu</CardTitle>
          <CardDescription>Arrow keys, typeahead and Escape. Items can be links.</CardDescription>
        </CardHeader>
        <CardContent>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="secondary" icon={<Avatar name="Founding" tone="agent" shape="square" size="sm" />}>
                Founding workspace
                <ChevronsUpDown className="text-ink-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
              <DropdownMenuItem>
                <Avatar name="Founding" tone="agent" shape="square" size="sm" />
                <span className="flex-1">Founding</span>
                <Check className="text-agent" />
              </DropdownMenuItem>
              <DropdownMenuItem>
                <Avatar name="Note One" tone="agent" shape="square" size="sm" />
                <span className="flex-1">Note One</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem>
                <Plus />
                Create workspace
                <DropdownMenuShortcut>N</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuItem tone="danger">
                <LogOut />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </CardContent>
      </Card>

      <Card className="md:col-span-2">
        <CardHeader>
          <CardTitle>Command palette</CardTitle>
          <CardDescription>Type to filter; arrow keys and Enter to go. In the product, ⌘K or Ctrl K opens it from anywhere in a workspace.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="secondary" onClick={() => setPaletteOpen(true)}>
            Open the command palette
          </Button>
          <CommandDialog open={paletteOpen} onOpenChange={setPaletteOpen} title="Command palette" description="Jump to a section or run an action">
            <CommandInput placeholder="Jump to a section, workspace or action…" />
            <CommandList>
              <CommandEmpty>Nothing matches.</CommandEmpty>
              <CommandGroup heading="Sections">
                {SECTIONS.map(({ label, icon: Icon, shortcut }) => (
                  <CommandItem
                    key={label}
                    onSelect={() => {
                      setPaletteOpen(false);
                      toast(`Would open ${label}`);
                    }}
                  >
                    <Icon />
                    {label}
                    <CommandShortcut>{shortcut}</CommandShortcut>
                  </CommandItem>
                ))}
              </CommandGroup>
              <CommandSeparator />
              <CommandGroup heading="Account">
                <CommandItem onSelect={() => setPaletteOpen(false)}>
                  <LogOut />
                  Sign out
                </CommandItem>
              </CommandGroup>
            </CommandList>
          </CommandDialog>
        </CardContent>
      </Card>
    </div>
  );
}

/** The agent-controls pattern: a busy button, an indeterminate bar, a toast at the end. */
function RunDemo() {
  const [running, setRunning] = useState(false);

  async function run() {
    setRunning(true);
    await wait(2200);
    setRunning(false);
    toast.success("Day 27 complete", { description: "The agent logged 5 entries." });
  }

  return (
    <div className="max-w-sm space-y-2">
      <Button icon={<Play />} loading={running} onClick={run}>
        {running ? "Running day 27…" : "Run day 27"}
      </Button>
      {running && <ProgressBar label="Running the cycle" />}
      <p aria-live="polite" className="min-h-4 text-xs text-ink-2">
        {running ? "Agent is reading invoices · screening counterparties · checking milestones." : ""}
      </p>
    </div>
  );
}

export function FeedbackDemo() {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Toasts</CardTitle>
          <CardDescription>For what went right. An action’s error stays in its form.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={() => toast.success("Invitation sent to ada@example.com")}>
            Success
          </Button>
          <Button variant="secondary" size="sm" onClick={() => toast("Copied to the clipboard")}>
            Plain
          </Button>
          <Button variant="secondary" size="sm" onClick={() => toast.info("The next cycle runs at 18:17 UTC")}>
            Info
          </Button>
          <Button variant="secondary" size="sm" onClick={() => toast.warning("Screening is using the bundled list")}>
            Warning
          </Button>
          <Button variant="secondary" size="sm" onClick={() => toast.error("The cycle failed at AP")}>
            Error
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => toast.promise(wait(1500), { loading: "Checking every signature…", success: "Chain intact — 163 signatures verified", error: "Not checked" })}
          >
            Promise
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => toast.success("Counterparty added", { description: "Screened against OpenSanctions: clear.", action: { label: "View", onClick: () => {} } })}
          >
            With an action
          </Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Long-running work and copying</CardTitle>
          <CardDescription>The busy state stays on the control that started it.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <RunDemo />
          <div className="flex flex-wrap items-center gap-3">
            <span className="font-mono text-xs text-ink-2">0x3f5c…9a1e</span>
            <CopyButton value="0x3f5c9a8e7d6b5a4c3f2e1d0c9b8a7f6e5d4c9a1e" label="Copy transaction hash" />
            <CopyButton value="https://www.vestiarion.xyz/invite/example" variant="secondary">
              Copy link
            </CopyButton>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export function TabsDemo() {
  return (
    <Tabs defaultValue="manual">
      <TabsList aria-label="Invoice intake">
        <TabsTrigger value="manual">Enter one invoice</TabsTrigger>
        <TabsTrigger value="csv">Import CSV</TabsTrigger>
        <TabsTrigger value="api">Through the API</TabsTrigger>
      </TabsList>
      <TabsContent value="manual">
        <Callout tone="agent" title="The agent evaluates it on the next cycle">
          One invoice, typed in: direction, counterparty, amount, due date.
        </Callout>
      </TabsContent>
      <TabsContent value="csv">
        <Callout title="Nothing is imported until you confirm the preview">Up to 200 rows from a CSV, checked row by row first.</Callout>
      </TabsContent>
      <TabsContent value="api">
        <Callout tone="proof" title="Read-only for now">
          The v1 API reads invoices; writing them stays in the console.
        </Callout>
      </TabsContent>
    </Tabs>
  );
}
