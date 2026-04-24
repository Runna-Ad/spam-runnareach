"use client";

import { X } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils";

interface TagInputProps {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  maxTags?: number;
  className?: string;
  id?: string;
  "aria-label"?: string;
}

/**
 * Controlled tag-pill input.
 *   - Enter or comma adds the current buffer as a pill
 *   - Backspace on empty input removes the last pill
 *   - Paste with commas splits into multiple pills
 *   - × button on each pill removes it
 *   - Duplicates (case-insensitive, trimmed) are silently ignored
 */
export function TagInput({
  value,
  onChange,
  placeholder = "Type and press Enter",
  maxTags = 30,
  className,
  id,
  "aria-label": ariaLabel,
}: TagInputProps) {
  const [buffer, setBuffer] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement>(null);

  const addTags = (raw: string) => {
    const parts = raw
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length === 0) return;
    const lowerSeen = new Set(value.map((v) => v.toLowerCase()));
    const next = [...value];
    for (const p of parts) {
      const key = p.toLowerCase();
      if (lowerSeen.has(key)) continue;
      if (next.length >= maxTags) break;
      next.push(p);
      lowerSeen.add(key);
    }
    if (next.length !== value.length) onChange(next);
    setBuffer("");
  };

  const removeTag = (i: number) => {
    const next = value.slice(0, i).concat(value.slice(i + 1));
    onChange(next);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      if (buffer.trim()) addTags(buffer);
    } else if (e.key === "Backspace" && buffer === "" && value.length > 0) {
      e.preventDefault();
      removeTag(value.length - 1);
    }
  };

  const handleBlur = () => {
    if (buffer.trim()) addTags(buffer);
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData("text");
    if (pasted.includes(",")) {
      e.preventDefault();
      addTags(pasted);
    }
  };

  return (
    <div
      className={cn(
        "flex min-h-9 w-full flex-wrap items-center gap-1 rounded-[var(--radius-md)] px-2 py-1",
        "bg-[var(--color-bg-900)] ring-1 ring-inset ring-[var(--color-border-default)]",
        "transition-[box-shadow,background]",
        "duration-[var(--duration-fast)] ease-[var(--ease-standard)]",
        "focus-within:ring-[var(--color-accent-300)]",
        "hover:ring-[var(--color-border-strong)] focus-within:hover:ring-[var(--color-accent-300)]",
        className,
      )}
      onClick={() => inputRef.current?.focus()}
      role="presentation"
    >
      {value.map((tag, i) => (
        <span
          key={`${tag}-${i}`}
          className={cn(
            "inline-flex items-center gap-1 rounded-[var(--radius-sm)] px-1.5 py-0.5",
            "text-xs font-medium tracking-tight",
            "bg-[color-mix(in_oklab,var(--color-accent-300),transparent_80%)] text-[var(--color-accent-300)]",
            "ring-1 ring-inset ring-[color-mix(in_oklab,var(--color-accent-300),transparent_70%)]",
          )}
        >
          {tag}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              removeTag(i);
            }}
            className={cn(
              "grid h-3.5 w-3.5 place-items-center rounded-full",
              "text-[var(--color-accent-300)]",
              "hover:bg-[var(--color-accent-300)] hover:text-[var(--color-bg-900)]",
              "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-accent-300)]",
            )}
            aria-label={`Remove ${tag}`}
          >
            <X className="h-2.5 w-2.5" aria-hidden strokeWidth={3} />
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        id={id}
        aria-label={ariaLabel}
        value={buffer}
        onChange={(e) => setBuffer(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        onPaste={handlePaste}
        placeholder={value.length === 0 ? placeholder : ""}
        className={cn(
          "flex-1 min-w-[60px] bg-transparent px-1 py-0.5 text-sm outline-none",
          "text-[var(--color-fg-50)] placeholder:text-[var(--color-fg-700)]",
        )}
      />
    </div>
  );
}
