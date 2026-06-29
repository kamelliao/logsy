import { NoteEditor } from "./NoteEditor";
import { useStore } from "@/store";

export function NotebookPanel() {
  const fileName = useStore((s) => {
    const f = s.doc.files.find((x) => x.id === s.doc.activeFileId);
    return f?.name ?? "notebook";
  });
  const getTitle = () => fileName.replace(/\.[^.]+$/, "");

  return (
    <div className="nb-panel">
      <NoteEditor onGetTitle={getTitle} />
    </div>
  );
}
