import { vi } from "vitest";
import type { Plugin } from "siyuan";
import type { ItemProcessor } from "../src/services/item-processor";
import type { LibraryMembershipService } from "../src/services/library-membership";
const state = vi.hoisted(() => ({ current: "lib", open: vi.fn(() => ({ destroy: vi.fn() })) }));
vi.mock("../src/ui/dom", () => ({ currentDocumentId: () => state.current }));
vi.mock("../src/ui/dialogs/library-membership", () => ({ openMembershipDialog: state.open }));
import { monitorLibraryMembership } from "../src/ui/library-membership-monitor";

function fixture() {
  const listeners = new Map<string, (event: unknown) => void>();
  const eventBus = { on: vi.fn((name, fn) => listeners.set(name, fn)), off: vi.fn() };
  const scan = vi.fn(async (libraryId: string) => ({ libraryId, differences: [{ kind: "delete-note", docId: "extra" }] }));
  const processor = { runMembershipChange: (fn: () => unknown) => Promise.resolve().then(fn) };
  const dispose = monitorLibraryMembership({ eventBus } as unknown as Plugin,
    { scan } as unknown as LibraryMembershipService, processor as unknown as ItemProcessor);
  const activate = (id: string) => { state.current = id; listeners.get("switch-protyle")!({ detail: { protyle: { block: { rootID: id } } } }); };
  return { scan, dispose, activate, eventBus, listeners };
}

beforeEach(() => { vi.useFakeTimers(); state.current = "lib"; state.open.mockClear(); });
afterEach(() => vi.useRealTimers());

it("checks the startup document once and debounces repeat activation events", async () => {
  const { activate, scan, dispose } = fixture();
  activate("lib"); activate("lib");
  await vi.advanceTimersByTimeAsync(3000);
  expect(scan).toHaveBeenCalledTimes(1);
  expect(state.open).toHaveBeenCalledTimes(1);
  dispose();
});

it("does not interrupt another document with stale or background scan results", async () => {
  const { activate, listeners, dispose } = fixture();
  activate("lib");
  state.current = "paper";
  listeners.get("loaded-protyle-static")!({ detail: { protyle: { block: { rootID: "background" } } } });
  await vi.advanceTimersByTimeAsync(1300);
  expect(state.open).not.toHaveBeenCalled();
  dispose();
});

it("removes event handlers and cancels pending checks on unload", async () => {
  const { activate, dispose, scan, eventBus } = fixture();
  activate("lib"); dispose();
  await vi.advanceTimersByTimeAsync(4000);
  expect(scan).not.toHaveBeenCalled();
  expect(eventBus.off).toHaveBeenCalledTimes(2);
});
