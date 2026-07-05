import type { FileGroup, LogFile } from "@/types";
import { uid } from "@/lib/defaults";
import type { Store } from "@/store";

/** Container id for the "not in any group" bucket, rendered above the groups. */
export const UNGROUPED = "__ungrouped__";

export interface FileGroupActions {
  /** Create an empty file group and return its id (name auto-disambiguated). */
  createFileGroup: (name?: string) => string;
  renameFileGroup: (id: string, name: string) => void;
  toggleFileGroupCollapsed: (id: string) => void;
  /** Remove a group; its member files fall back to the ungrouped bucket. */
  deleteFileGroup: (id: string) => void;
  /** Assign one file to a group (or null = ungrouped), appended to that block. */
  moveFileToGroup: (fileId: string, groupId: string | null) => void;
  /**
   * Commit a whole sidebar drag arrangement in one step. `containers` maps a
   * container id (UNGROUPED or a group id) to its ordered file ids; `groupOrder`
   * is the new top-level group order. Rebuilds `files` in visual order and sets
   * every file's groupId. Organizational, so it never lands on the undo stack.
   */
  applyFileLayout: (
    containers: Record<string, string[]>,
    groupOrder: string[],
  ) => void;
}

/**
 * File-group organization: named, collapsible sidebar sections that partition the
 * open log files. Groups are purely a container — a file's filters/markers are
 * untouched by grouping. Mirrors the FilterGroup model (id + name + collapsed on
 * a parallel array, `LogFile.groupId` referencing it). Every action is
 * non-undoable, matching how opening/closing/reordering files already behaves.
 */
export function createFileGroupActions(get: () => Store): FileGroupActions {
  const patch = (fn: (s: import("@/types").AppState) => void) =>
    get().patchState(fn, { undoable: false });

  return {
    createFileGroup: (name) => {
      const id = uid("fg");
      patch((s) => {
        if (!s.fileGroups) s.fileGroups = [];
        const names = new Set(s.fileGroups.map((g) => g.name));
        let n = name ?? "New Group";
        if (!name && names.has(n)) {
          let i = 1;
          while (names.has(`New Group ${i}`)) i++;
          n = `New Group ${i}`;
        }
        const grp: FileGroup = { id, name: n, collapsed: false };
        s.fileGroups.push(grp);
      });
      return id;
    },
    renameFileGroup: (id, name) =>
      patch((s) => {
        const g = s.fileGroups?.find((x) => x.id === id);
        if (g) g.name = name;
      }),
    toggleFileGroupCollapsed: (id) =>
      patch((s) => {
        const g = s.fileGroups?.find((x) => x.id === id);
        if (g) g.collapsed = !g.collapsed;
      }),
    deleteFileGroup: (id) =>
      patch((s) => {
        if (!s.fileGroups) return;
        s.fileGroups = s.fileGroups.filter((x) => x.id !== id);
        // Keep the files — just drop them back into the ungrouped bucket. They
        // keep their position in `files`, so ungrouped rendering picks them up.
        for (const f of s.files) if (f.groupId === id) f.groupId = null;
        if (s.fileGroups.length === 0) delete s.fileGroups;
      }),
    moveFileToGroup: (fileId, groupId) =>
      patch((s) => {
        const f = s.files.find((x) => x.id === fileId);
        if (!f) return;
        f.groupId = groupId;
        // Move the file to the end of its new block so it lands where the group
        // renders it, not stranded at its old index.
        const idx = s.files.indexOf(f);
        s.files.splice(idx, 1);
        if (groupId === null) {
          // Ungrouped files render below every group, so they trail in `files` —
          // append to the very end.
          s.files.push(f);
        } else {
          // After the last file already in this group.
          let at = -1;
          s.files.forEach((x, i) => {
            if (x.groupId === groupId) at = i;
          });
          s.files.splice(at + 1, 0, f);
        }
      }),
    applyFileLayout: (containers, groupOrder) =>
      patch((s) => {
        const byId = new Map(s.files.map((f) => [f.id, f] as const));
        const next: LogFile[] = [];
        const emit = (cid: string, gid: string | null) => {
          for (const fid of containers[cid] ?? []) {
            const f = byId.get(fid);
            if (f) {
              f.groupId = gid;
              next.push(f);
              byId.delete(fid);
            }
          }
        };
        // Groups render first, loose files last — keep `files` in that visual
        // order so drag-reorder math and the ungrouped-is-trailing assumption in
        // moveFileToGroup hold.
        for (const gid of groupOrder) emit(gid, gid);
        emit(UNGROUPED, null);
        for (const f of byId.values()) next.push(f); // safety: never drop a file
        s.files = next;
        // Reorder the groups themselves to match the dragged header order.
        if (s.fileGroups) {
          const gmap = new Map(s.fileGroups.map((g) => [g.id, g] as const));
          s.fileGroups = groupOrder
            .map((id) => gmap.get(id))
            .filter((g): g is FileGroup => !!g);
        }
      }),
  };
}
