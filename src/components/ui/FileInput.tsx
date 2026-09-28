"use client";

import { Upload } from "lucide-react";
import { useRef, useState, type DragEvent, type RefObject } from "react";
import { cn } from "./cn";

export interface FileInputProps {
  id: string;
  name?: string;
  accept?: string;
  label: string;
  description?: string;
  disabled?: boolean;
  /** Called with the chosen or dropped file, or undefined when the choice is cleared. */
  onFile: (file: File | undefined) => void;
  /** For the owner to clear the input after using its file. */
  inputRef?: RefObject<HTMLInputElement | null>;
}

/**
 * A drop zone around a visually hidden file input. It is a real input — a
 * click, the keyboard and a dropped file all reach it — so the file is in the
 * form’s `FormData` however it was chosen.
 */
export function FileInput({ id, name, accept, label, description, disabled = false, onFile, inputRef }: FileInputProps) {
  const localRef = useRef<HTMLInputElement>(null);
  const ref = inputRef ?? localRef;
  const [dragging, setDragging] = useState(false);

  function onDragOver(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    if (!disabled) setDragging(true);
  }

  function onDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragging(false);
    if (disabled) return;
    if (ref.current) ref.current.files = event.dataTransfer.files;
    onFile(event.dataTransfer.files[0]);
  }

  return (
    <label
      htmlFor={id}
      onDragOver={onDragOver}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      className={cn(
        "group flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-line-strong bg-surface/60 px-6 py-8 text-center",
        "transition-colors duration-150 ease-standard hover:border-agent-line hover:bg-agent-soft/40",
        "has-[input:focus-visible]:border-agent has-[input:focus-visible]:ring-4 has-[input:focus-visible]:ring-agent-soft",
        dragging && "border-agent bg-agent-soft/60",
        disabled && "pointer-events-none opacity-60"
      )}
    >
      <span aria-hidden className="grid size-10 place-items-center rounded-full bg-agent-soft text-agent transition-transform duration-150 ease-standard group-hover:-translate-y-0.5">
        <Upload className="size-5" />
      </span>
      <span className="text-sm font-semibold text-ink">{label}</span>
      {description && <span className="text-xs text-ink-3">{description}</span>}
      <input
        ref={ref}
        id={id}
        name={name}
        type="file"
        accept={accept}
        disabled={disabled}
        className="sr-only"
        onChange={(event) => onFile(event.currentTarget.files?.[0])}
      />
    </label>
  );
}
