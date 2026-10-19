import React, { useId, useLayoutEffect, useSyncExternalStore } from "react";
import { ArrowRight } from "lucide-react";
import { isBriefCapabilityEnabled } from "../../../../../src/brief/capabilities";
import type { BriefRoomModule, BriefShellPort } from "../../contracts";
import {
  BriefButton,
  BriefInput,
  BriefSelect,
} from "../../components/controls";
import { MemoryController } from "./controller";
import {
  dateGroup,
  usageLabel,
  type MemoryFilters,
  type MemoryItem,
} from "./model";
import { FilterField } from "./FilterField";
import "./stream.css";

export interface MemoryBinding {
  source: "live" | "fixture";
  scopeId: string;
  capabilities?: unknown;
  controller: MemoryController;
  /** Authorized host catalogs, never inferred collection-wide facets from a fetched page. */
  sourceOptions?: readonly string[];
  useOptions?: readonly { value: string; label: string }[];
  /** D26 owns detail; this seam passes canonical identity without implementing that room. */
  onOpen?: (factId: string) => void;
}
export function memoryAvailable(
  shell: BriefShellPort,
  binding?: MemoryBinding,
) {
  return (
    !!binding &&
    !!binding.scopeId &&
    binding.source === (shell.mode === "preview" ? "fixture" : "live") &&
    binding.controller.scopeId === binding.scopeId &&
    binding.controller.source === binding.source &&
    (shell.mode === "preview" ||
      (isBriefCapabilityEnabled(binding.capabilities, "memoryStream") &&
        isBriefCapabilityEnabled(binding.capabilities, "memoryUsage")))
  );
}
export function MemoryStreamRoom({
  shell,
  binding,
}: {
  shell: BriefShellPort;
  binding?: MemoryBinding;
}) {
  const available = memoryAvailable(shell, binding);
  useLayoutEffect(() => {
    binding?.controller.setAccess(available);
  }, [available, binding?.controller]);
  if (!available || !binding)
    return (
      <section className="brief-memory-room">
        <h1 className="brief-type-room-title">Memory</h1>
        <p role="status">Memory search is unavailable here.</p>
      </section>
    );
  return (
    <ConnectedMemory
      key={`${binding.source}:${binding.scopeId}`}
      binding={binding}
    />
  );
}
function ConnectedMemory({ binding }: { binding: MemoryBinding }) {
  const controller = binding.controller;
  const { filters, read, loadingMore } = useSyncExternalStore(
    controller.subscribe,
    controller.snapshot,
    controller.snapshot,
  );
  const resultsId = useId();
  const page = "data" in read ? read.data : null;
  const groups = new Map<string, MemoryItem[]>();
  for (const row of page?.items ?? []) {
    const group = dateGroup(
      row.updatedAt,
      "asOf" in read ? read.asOf : Date.now(),
    );
    groups.set(group, [...(groups.get(group) ?? []), row]);
  }
  const changed = Boolean(
    filters.search ||
    filters.source ||
    filters.usedIn ||
    filters.updated !== "any",
  );
  return (
    <section className="brief-memory-room" aria-labelledby="brief-memory-title">
      <h1 id="brief-memory-title" className="brief-type-room-title">
        Memory
      </h1>
      <form
        className="brief-memory-filters"
        role="search"
        aria-label="Search memory"
        onSubmit={(event) => {
          event.preventDefault();
          void controller.refresh();
        }}
      >
        <BriefInput
          label="Search"
          type="search"
          placeholder="Search memory…"
          maxLength={256}
          value={filters.search}
          onChange={(event) =>
            controller.setFilters({ search: event.target.value })
          }
          aria-controls={resultsId}
        />
        <FilterField
          label="Source"
          anyLabel="Any source"
          placeholder="Exact source label"
          maxLength={4000}
          multiline
          value={filters.source}
          options={(binding.sourceOptions ?? []).map((value) => ({
            value,
            label: JSON.stringify(value).slice(1, -1),
          }))}
          onChange={(source) => controller.setFilters({ source }, 0)}
        />
        <FilterField
          label="Used in"
          anyLabel="Any conversation or run"
          placeholder="conversation:<id> or run:<id>"
          maxLength={220}
          value={filters.usedIn}
          options={binding.useOptions ?? []}
          onChange={(usedIn) => controller.setFilters({ usedIn }, 0)}
        />
        <BriefSelect
          label="Updated"
          value={filters.updated}
          onChange={(event) =>
            controller.setFilters(
              { updated: event.target.value as MemoryFilters["updated"] },
              0,
            )
          }
        >
          <option value="any">Any time</option>
          <option value="day">Past 24 hours</option>
          <option value="week">Past 7 days</option>
          <option value="month">Past 30 days</option>
        </BriefSelect>
      </form>
      <div className="brief-memory-results-line">
        <span role="status" aria-live="polite" aria-atomic="true">
          Results{" "}
          <strong>{page ? page.count.matched.toLocaleString() : "—"}</strong>
          {page && (
            <span className="brief-memory-count-detail">
              {page.items.length} shown of {page.count.total.toLocaleString()}{" "}
              memories
            </span>
          )}
        </span>
        <span className="brief-memory-sort">Recently updated</span>
        <BriefButton
          size="sm"
          variant="secondary"
          disabled={!changed}
          onClick={() => controller.clear()}
        >
          Clear
        </BriefButton>
      </div>
      <div
        id={resultsId}
        className="brief-memory-results"
        aria-busy={read.state === "loading" || loadingMore}
      >
        {read.state === "loading" && (
          <div className="brief-memory-message" role="status">
            Searching memory…
            <div className="brief-memory-skeleton" aria-hidden="true" />
          </div>
        )}
        {read.state === "empty" && (
          <div className="brief-memory-message">
            <h2>
              {read.data.count.total
                ? "No matching memories"
                : "No memories yet"}
            </h2>
            <p>
              {read.data.count.total
                ? "Try another search or clear your filters."
                : "Facts will appear here when memory is available."}
            </p>
          </div>
        )}
        {"reason" in read && (
          <div
            className="brief-memory-message"
            role={read.state === "error" ? "alert" : "status"}
          >
            <h2>
              {read.state === "stale"
                ? "Memory has changed"
                : read.state === "error"
                  ? "Could not load memory"
                  : "Memory is unavailable"}
            </h2>
            <p>{read.reason}</p>
            <BriefButton onClick={() => void controller.refresh()}>
              Refresh memory
            </BriefButton>
          </div>
        )}
        {[...groups].map(([label, rows]) => (
          <section
            className="brief-memory-group"
            key={label}
            aria-label={label}
          >
            <h2>{label}</h2>
            <ul>
              {rows.map((row) => (
                <li key={row.factId}>
                  <button
                    type="button"
                    className="brief-memory-row"
                    data-fact-id={row.factId}
                    aria-disabled={!binding.onOpen}
                    title={
                      binding.onOpen
                        ? undefined
                        : "Memory detail is not connected yet"
                    }
                    onClick={() => binding.onOpen?.(row.factId)}
                  >
                    <span className="brief-memory-row-body">
                      <span className="brief-memory-sentence">
                        {row.sentence}
                      </span>
                      <span className="brief-memory-meta">
                        <span>
                          {row.sourceSummary.labels.join(" · ") ||
                            "Source not recorded"}
                        </span>
                        <span>{usageLabel(row)}</span>
                      </span>
                      <span className="brief-memory-qualification">
                        {row.scope && <span>Scope: {row.scope}</span>}
                        <span>{row.basis}</span>
                        {row.status === "contested" && <span>Contested</span>}
                        {(row.validity.from !== null ||
                          row.validity.to !== null) && (
                          <span>
                            Valid{" "}
                            {row.validity.from === null
                              ? "from an unspecified date"
                              : new Date(
                                  row.validity.from,
                                ).toLocaleDateString()}{" "}
                            –{" "}
                            {row.validity.to === null
                              ? "no end recorded"
                              : new Date(row.validity.to).toLocaleDateString()}
                          </span>
                        )}
                      </span>
                    </span>
                    <ArrowRight size={16} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
        {page?.nextCursor && (
          <div className="brief-memory-more">
            <BriefButton
              state={loadingMore ? "pending" : "idle"}
              onClick={() => void controller.loadMore()}
            >
              Load more memories
            </BriefButton>
          </div>
        )}
      </div>
      {page && (
        <p className="brief-memory-coverage">
          {page.usedIn.state === "unavailable"
            ? "Used in filtering is unavailable without retained supplied evidence. "
            : ""}
          Recorded use covers retained provider handoffs, not model reliance or
          verified outcomes. Older and uninstrumented use may be missing.
        </p>
      )}
    </section>
  );
}
/** Optional registration; the production registry and default capability flags stay unchanged. */
export function memoryRegistrations(
  useBinding: () => MemoryBinding | undefined,
): readonly BriefRoomModule[] {
  return [
    {
      id: "memory",
      title: "Memory",
      legacyRoom: "memory",
      Body: ({ shell }) => (
        <MemoryStreamRoom shell={shell} binding={useBinding()} />
      ),
    },
  ];
}
