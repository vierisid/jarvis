import React, {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { isBriefCapabilityEnabled } from "../../../../../src/brief/capabilities";
import type { BriefRoomModule, BriefShellPort } from "../../contracts";
import {
  memoryAvailable,
  MemoryStreamRoom,
  type MemoryBinding,
} from "../stream/MemoryStreamRoom";
import { MemoryDetailController } from "./controller";
import { MemoryDetailRoom } from "./MemoryDetailRoom";
export interface MemoryExperienceBinding {
  stream: MemoryBinding;
  detail: MemoryDetailController;
}
export function detailAvailable(
  shell: BriefShellPort,
  binding?: MemoryExperienceBinding,
) {
  return (
    !!binding &&
    memoryAvailable(shell, binding.stream) &&
    binding.detail.scopeId === binding.stream.scopeId &&
    binding.detail.source === binding.stream.source &&
    (shell.mode === "preview" ||
      isBriefCapabilityEnabled(binding.stream.capabilities, "memoryForget"))
  );
}
export function nearestReturnId(
  ids: readonly string[],
  original: string,
  available: readonly string[],
  preferred?: string | null,
) {
  const found = new Set(available);
  if (preferred && found.has(preferred)) return preferred;
  if (found.has(original)) return original;
  const index = ids.indexOf(original);
  for (let distance = 1; distance <= ids.length; distance++) {
    for (const candidate of [ids[index + distance], ids[index - distance]])
      if (candidate && found.has(candidate)) return candidate;
  }
  return available[0] ?? null;
}
/** Mount this optional pair behind the host gate, retaining both controllers per scope. */
export function MemoryExperience({
  shell,
  binding,
}: {
  shell: BriefShellPort;
  binding?: MemoryExperienceBinding;
}) {
  const allowed = detailAvailable(shell, binding);
  useLayoutEffect(() => {
    binding?.detail.setAccess(allowed);
  }, [binding?.detail, allowed]);
  if (!binding) return <MemoryStreamRoom shell={shell} />;
  return (
    <ConnectedExperience
      key={`${binding.stream.source}:${binding.stream.scopeId}`}
      shell={shell}
      binding={binding}
      allowed={allowed}
    />
  );
}
function ConnectedExperience({
  shell,
  binding,
  allowed,
}: {
  shell: BriefShellPort;
  binding: MemoryExperienceBinding;
  allowed: boolean;
}) {
  const { detail, stream } = binding,
    root = useRef<HTMLDivElement>(null);
  const reading = shell.route.room === "memory-detail";
  const id = shell.route.selection.factId ?? "";
  const [restoreReady, setRestoreReady] = useState(false);
  const streamState = useSyncExternalStore(
    stream.controller.subscribe,
    stream.controller.snapshot,
    stream.controller.snapshot,
  );
  const detailState = useSyncExternalStore(
    detail.subscribe,
    detail.snapshot,
    detail.snapshot,
  );
  const highlight = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scroller = () =>
    root.current?.closest<HTMLElement>(".brief-workspace-content") ??
    root.current?.parentElement;
  useLayoutEffect(() => {
    detail.setAccess(allowed);
    if (reading && allowed) {
      const replacement = detail.snapshot().replacement;
      if (replacement?.from === id) {
        shell.navigate({
          room: "memory-detail",
          selection: { factId: replacement.to },
        });
        return;
      }
      detail.acknowledgeRoute(id);
      if (detail.snapshot().factId !== id) void detail.open(id);
    }
  }, [reading, id, allowed, detail, detailState.replacement, shell.navigate]);
  useLayoutEffect(() => {
    if (reading && allowed)
      scroller()?.scrollTo?.({ top: 0, behavior: "instant" });
  }, [reading, id, allowed]);
  useEffect(
    () => () => {
      if (highlight.current) clearTimeout(highlight.current);
    },
    [],
  );
  useEffect(() => {
    if (
      reading ||
      detailState.phase === "pending" ||
      (!detail.returnPending && !detail.dirty && !detail.origin) ||
      !memoryAvailable(shell, stream)
    ) {
      setRestoreReady(false);
      return;
    }
    if (detailState.factId !== null) detail.close();
    detail.returnPending = true;
    let active = true;
    void (async () => {
      if (detail.dirty) {
        await stream.controller.refresh();
        const count = detail.origin?.ids.length ?? 0;
        // Restore only the previously loaded bounded window; never scan an entire vault.
        while (active) {
          const read = stream.controller.snapshot().read;
          if (
            !("data" in read) ||
            !read.data.nextCursor ||
            read.data.items.length >= count
          )
            break;
          const before = read.data.items.length;
          await stream.controller.loadMore();
          const next = stream.controller.snapshot().read;
          if (!("data" in next) || next.data.items.length <= before) break;
        }
      }
      if (active) setRestoreReady(true);
    })();
    return () => {
      active = false;
    };
  }, [reading, allowed, detail, stream.controller, detailState.phase]);
  useLayoutEffect(() => {
    if (
      !restoreReady ||
      reading ||
      !detail.returnPending ||
      !root.current ||
      streamState.read.state === "loading"
    )
      return;
    const rows = [
      ...root.current.querySelectorAll<HTMLButtonElement>(".brief-memory-row"),
    ];
    const origin = detail.origin;
    const targetId = origin
      ? nearestReturnId(
          origin.ids,
          origin.factId,
          rows.map((row) => row.dataset.factId!),
          detail.returnId,
        )
      : null;
    const row = rows.find((row) => row.dataset.factId === targetId),
      parent = scroller();
    if (row && parent) {
      const offset = Math.max(
        0,
        Math.min(
          origin?.offset ?? 0,
          Math.max(0, parent.clientHeight - row.offsetHeight),
        ),
      );
      parent.scrollTop +=
        row.getBoundingClientRect().top -
        parent.getBoundingClientRect().top -
        offset;
      row.focus({ preventScroll: true });
      row.dataset.returned = "true";
      if (highlight.current) clearTimeout(highlight.current);
      highlight.current = setTimeout(() => {
        delete row.dataset.returned;
      }, 1600);
    } else {
      if (parent) parent.scrollTop = origin?.scrollTop ?? 0;
      root.current
        .querySelector<HTMLInputElement>('input[type="search"]')
        ?.focus({ preventScroll: true });
    }
    detail.returnPending = false;
    detail.origin = null;
    detail.returnId = null;
    detail.dirty = false;
    setRestoreReady(false);
  }, [restoreReady, reading, streamState, detail]);
  const open = (factId: string) => {
    if (!allowed || !root.current) return;
    const rows = [
        ...root.current.querySelectorAll<HTMLButtonElement>(
          ".brief-memory-row",
        ),
      ],
      row = rows.find((row) => row.dataset.factId === factId);
    const parent = scroller(),
      sentence = row
        ?.querySelector(".brief-memory-sentence")
        ?.getBoundingClientRect();
    detail.origin = {
      factId,
      ids: rows.map((row) => row.dataset.factId!),
      offset:
        row && parent
          ? row.getBoundingClientRect().top - parent.getBoundingClientRect().top
          : 0,
      scrollTop: parent?.scrollTop ?? 0,
      ...(sentence
        ? { sentence: { top: sentence.top, left: sentence.left } }
        : {}),
    };
    detail.returnId = factId;
    detail.returnPending = false;
    shell.navigate({ room: "memory-detail", selection: { factId } });
  };
  return (
    <div ref={root} className="brief-memory-experience">
      <div hidden={reading}>
        <MemoryStreamRoom
          shell={shell}
          binding={{ ...stream, onOpen: allowed ? open : undefined }}
        />
      </div>
      {reading &&
        (allowed ? (
          <MemoryDetailRoom
            controller={detail}
            onBack={() => {
              if (detail.close())
                shell.navigate({ room: "memory", selection: {} });
            }}
            onInspect={(factId) =>
              shell.navigate({ room: "memory-detail", selection: { factId } })
            }
          />
        ) : (
          <section className="brief-memory-detail">
            <h1 className="brief-type-room-title">Memory</h1>
            <p role="status">Memory detail is unavailable here.</p>
            <button
              onClick={() => shell.navigate({ room: "memory", selection: {} })}
            >
              All memories
            </button>
          </section>
        ))}
    </div>
  );
}
export function memoryDetailRegistrations(
  useBinding: () => MemoryExperienceBinding | undefined,
): readonly BriefRoomModule[] {
  const Body = ({ shell }: { shell: BriefShellPort }) => (
    <MemoryExperience shell={shell} binding={useBinding()} />
  );
  return [
    { id: "memory", title: "Memory", legacyRoom: "memory", Body },
    { id: "memory-detail", title: "Memory detail", legacyRoom: "memory", Body },
  ];
}
