"use client";

import { ChevronDown, X } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils";

export type TagSuggestionGroup = {
  /** Group label, e.g. "Used by your team" or "Standard". Set to null for ungrouped. */
  label: string | null;
  /** The values shown under this group. Order is preserved. */
  values: readonly string[];
};

interface TagInputProps {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  maxTags?: number;
  className?: string;
  id?: string;
  "aria-label"?: string;
  /**
   * Optional autocomplete suggestions. When provided, the input shows a
   * dropdown filtered by the current buffer — pick to add. Free-form
   * typing still works for any value not in the list.
   */
  suggestions?: TagSuggestionGroup[];
}

/**
 * Controlled tag-pill input with optional typeahead suggestions.
 *   - Enter or comma adds the current buffer as a pill
 *   - Backspace on empty input removes the last pill
 *   - Paste with commas splits into multiple pills
 *   - × button on each pill removes it
 *   - Duplicates (case-insensitive, trimmed) are silently ignored
 *
 * When `suggestions` is provided:
 *   - A dropdown opens on focus or buffer change, filtered by the buffer
 *   - Already-selected values are filtered out
 *   - Click or Enter on a highlighted suggestion adds it
 *   - ↑/↓ navigates highlighted suggestion
 *   - Esc closes the dropdown
 *   - Click outside closes the dropdown
 */
export function TagInput({
  value,
  onChange,
  placeholder = "Type and press Enter",
  maxTags = 30,
  className,
  id,
  "aria-label": ariaLabel,
  suggestions,
}: TagInputProps) {
  const [buffer, setBuffer] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const [highlight, setHighlight] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);

  const hasSuggestions = (suggestions?.length ?? 0) > 0;

  // Build a flat list of [groupIndex, value] pairs after filtering by
  // buffer + already-selected values. This lets ↑/↓ skip group headers
  // cleanly.
  const filteredGroups = React.useMemo(() => {
    if (!suggestions) return [];
    const lowerSelected = new Set(value.map((v) => v.toLowerCase()));
    const buf = buffer.trim().toLowerCase();
    return suggestions
      .map((g) => ({
        label: g.label,
        values: g.values.filter((v) => {
          const lower = v.toLowerCase();
          if (lowerSelected.has(lower)) return false;
          if (!buf) return true;
          return lower.includes(buf);
        }),
      }))
      .filter((g) => g.values.length > 0);
  }, [suggestions, value, buffer]);

  const flatSuggestions = React.useMemo(
    () => filteredGroups.flatMap((g) => g.values),
    [filteredGroups],
  );

  // Reset highlight when the filtered list changes.
  React.useEffect(() => {
    setHighlight(0);
  }, [buffer, value]);

  // Click-outside closes the dropdown.
  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

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
    onChange(value.slice(0, i).concat(value.slice(i + 1)));
  };

  const pickSuggestion = (s: string) => {
    addTags(s);
    inputRef.current?.focus();
    setOpen(true); // stay open so multiple values can be added quickly
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape" && open) {
      setOpen(false);
      e.preventDefault();
      return;
    }
    if (open && hasSuggestions && flatSuggestions.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlight((h) => (h + 1) % flatSuggestions.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlight((h) => (h - 1 + flatSuggestions.length) % flatSuggestions.length);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const pick = flatSuggestions[highlight];
        if (pick) {
          pickSuggestion(pick);
        } else if (buffer.trim()) {
          addTags(buffer);
        }
        return;
      }
    }
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      if (buffer.trim()) addTags(buffer);
      return;
    }
    if (e.key === "Backspace" && buffer === "" && value.length > 0) {
      e.preventDefault();
      removeTag(value.length - 1);
    }
  };

  const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    // Don't commit-on-blur if focus is moving to a suggestion within
    // the dropdown — we'll close via mousedown handler instead.
    if (containerRef.current?.contains(e.relatedTarget as Node)) return;
    if (buffer.trim()) addTags(buffer);
    setOpen(false);
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData("text");
    if (pasted.includes(",")) {
      e.preventDefault();
      addTags(pasted);
    }
  };

  // Compute global flat-index → useful for highlight math across groups.
  let runningIndex = 0;

  return (
    <div ref={containerRef} className={cn("relative", className)}>
      <div
        className={cn(
          "flex min-h-9 w-full flex-wrap items-center gap-1 rounded-[var(--radius-md)] px-2 py-1",
          "bg-[var(--color-bg-900)] ring-1 ring-inset ring-[var(--color-border-default)]",
          "transition-[box-shadow,background]",
          "duration-[var(--duration-fast)] ease-[var(--ease-standard)]",
          "focus-within:ring-[var(--color-accent-300)]",
          "hover:ring-[var(--color-border-strong)] focus-within:hover:ring-[var(--color-accent-300)]",
        )}
        onClick={() => {
          inputRef.current?.focus();
          if (hasSuggestions) setOpen(true);
        }}
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
          aria-autocomplete={hasSuggestions ? "list" : undefined}
          aria-expanded={hasSuggestions ? open : undefined}
          value={buffer}
          onChange={(e) => {
            setBuffer(e.target.value);
            if (hasSuggestions) setOpen(true);
          }}
          onFocus={() => {
            if (hasSuggestions) setOpen(true);
          }}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          onPaste={handlePaste}
          placeholder={value.length === 0 ? placeholder : ""}
          className={cn(
            "flex-1 min-w-[60px] bg-transparent px-1 py-0.5 text-sm outline-none",
            "text-[var(--color-fg-50)] placeholder:text-[var(--color-fg-700)]",
          )}
        />
        {hasSuggestions ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setOpen((o) => !o);
              inputRef.current?.focus();
            }}
            className={cn(
              "grid h-5 w-5 place-items-center rounded-[var(--radius-sm)]",
              "text-[var(--color-fg-700)] hover:text-[var(--color-fg-300)]",
              open ? "rotate-180" : "",
              "transition-transform duration-[var(--duration-fast)]",
            )}
            aria-label={open ? "Close suggestions" : "Open suggestions"}
          >
            <ChevronDown className="h-3 w-3" aria-hidden />
          </button>
        ) : null}
      </div>

      {hasSuggestions && open && filteredGroups.length > 0 ? (
        <div
          className={cn(
            "absolute left-0 right-0 top-full z-30 mt-1 max-h-64 overflow-y-auto",
            "rounded-[var(--radius-md)] bg-[var(--color-bg-800)]",
            "ring-1 ring-inset ring-[var(--color-border-default)]",
            "shadow-[0_8px_24px_-12px_rgba(0,0,0,0.4)]",
            "py-1",
          )}
          role="listbox"
        >
          {filteredGroups.map((group, gi) => (
            <div key={`${group.label ?? "ungrouped"}-${gi}`}>
              {group.label ? (
                <div
                  className={cn(
                    "px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider",
                    "text-[var(--color-fg-700)]",
                  )}
                >
                  {group.label}
                </div>
              ) : null}
              {group.values.map((s) => {
                const isHighlighted = runningIndex === highlight;
                const myIndex = runningIndex;
                runningIndex++;
                return (
                  <button
                    type="button"
                    key={s}
                    onMouseDown={(e) => e.preventDefault()} // don't blur the input
                    onMouseEnter={() => setHighlight(myIndex)}
                    onClick={(e) => {
                      e.stopPropagation();
                      pickSuggestion(s);
                    }}
                    role="option"
                    aria-selected={isHighlighted}
                    className={cn(
                      "flex w-full items-center px-3 py-1.5 text-left text-sm",
                      isHighlighted
                        ? "bg-[var(--color-bg-700)] text-[var(--color-fg-50)]"
                        : "text-[var(--color-fg-300)] hover:bg-[var(--color-bg-700)] hover:text-[var(--color-fg-50)]",
                    )}
                  >
                    {s}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
