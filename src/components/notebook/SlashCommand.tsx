import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { Extension, type Editor, type Range } from "@tiptap/core";
import { Suggestion, type SuggestionProps } from "@tiptap/suggestion";
import { ReactRenderer } from "@tiptap/react";
import {
  Type,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  Quote,
  SquareCode,
  Minus,
  type LucideIcon,
} from "lucide-react";

// ── block catalogue ──────────────────────────────────────────────────────────

interface SlashItem {
  title: string;
  hint: string;
  icon: LucideIcon;
  /** Extra match terms besides the title (english + zh, matched lowercased). */
  keywords: string[];
  run: (editor: Editor, range: Range) => void;
}

const ITEMS: SlashItem[] = [
  {
    title: "Text",
    hint: "Plain paragraph",
    icon: Type,
    keywords: ["paragraph", "plain"],
    run: (e, r) => e.chain().focus().deleteRange(r).setParagraph().run(),
  },
  {
    title: "Heading 1",
    hint: "Large section heading",
    icon: Heading1,
    keywords: ["h1", "title"],
    run: (e, r) =>
      e.chain().focus().deleteRange(r).setNode("heading", { level: 1 }).run(),
  },
  {
    title: "Heading 2",
    hint: "Medium section heading",
    icon: Heading2,
    keywords: ["h2", "subtitle"],
    run: (e, r) =>
      e.chain().focus().deleteRange(r).setNode("heading", { level: 2 }).run(),
  },
  {
    title: "Heading 3",
    hint: "Small section heading",
    icon: Heading3,
    keywords: ["h3"],
    run: (e, r) =>
      e.chain().focus().deleteRange(r).setNode("heading", { level: 3 }).run(),
  },
  {
    title: "Bullet list",
    hint: "Unordered list",
    icon: List,
    keywords: ["ul", "unordered"],
    run: (e, r) => e.chain().focus().deleteRange(r).toggleBulletList().run(),
  },
  {
    title: "Numbered list",
    hint: "Ordered list",
    icon: ListOrdered,
    keywords: ["ol", "ordered"],
    run: (e, r) => e.chain().focus().deleteRange(r).toggleOrderedList().run(),
  },
  {
    title: "Quote",
    hint: "Blockquote",
    icon: Quote,
    keywords: ["blockquote"],
    run: (e, r) => e.chain().focus().deleteRange(r).toggleBlockquote().run(),
  },
  {
    title: "Code block",
    hint: "Syntax-highlighted code",
    icon: SquareCode,
    keywords: ["code", "pre"],
    run: (e, r) => e.chain().focus().deleteRange(r).toggleCodeBlock().run(),
  },
  {
    title: "Divider",
    hint: "Horizontal rule",
    icon: Minus,
    keywords: ["hr", "horizontal", "rule"],
    run: (e, r) => e.chain().focus().deleteRange(r).setHorizontalRule().run(),
  },
];

function filterItems(query: string): SlashItem[] {
  const q = query.toLowerCase().trim();
  if (!q) return ITEMS;
  return ITEMS.filter(
    (it) =>
      it.title.toLowerCase().includes(q) ||
      it.keywords.some((k) => k.toLowerCase().includes(q)),
  );
}

// ── menu component ───────────────────────────────────────────────────────────

interface SlashMenuHandle {
  onKeyDown: (event: KeyboardEvent) => boolean;
}
interface SlashMenuProps {
  items: SlashItem[];
  command: (item: SlashItem) => void;
}

const SlashMenu = forwardRef<SlashMenuHandle, SlashMenuProps>(
  function SlashMenu({ items, command }, ref) {
    const [index, setIndex] = useState(0);
    const listRef = useRef<HTMLDivElement>(null);

    // A new query re-filters the list — restart the highlight at the top.
    useEffect(() => setIndex(0), [items]);

    useEffect(() => {
      listRef.current
        ?.querySelector(`[data-idx="${index}"]`)
        ?.scrollIntoView({ block: "nearest" });
    }, [index]);

    useImperativeHandle(
      ref,
      () => ({
        onKeyDown: (event) => {
          if (!items.length) return false;
          if (event.key === "ArrowDown") {
            setIndex((i) => (i + 1) % items.length);
            return true;
          }
          if (event.key === "ArrowUp") {
            setIndex((i) => (i - 1 + items.length) % items.length);
            return true;
          }
          if (event.key === "Enter") {
            command(items[index]);
            return true;
          }
          return false;
        },
      }),
      [items, index, command],
    );

    if (!items.length) {
      return (
        <div className="nb-slash-menu">
          <div className="nb-slash-empty">No matching block</div>
        </div>
      );
    }
    return (
      <div className="nb-slash-menu" ref={listRef}>
        {items.map((it, i) => (
          <button
            key={it.title}
            data-idx={i}
            className={"nb-slash-item" + (i === index ? " active" : "")}
            onMouseEnter={() => setIndex(i)}
            onMouseDown={(e) => {
              e.preventDefault(); // keep the editor focused
              command(it);
            }}
          >
            <span className="nb-slash-icon">
              <it.icon size={13} />
            </span>
            <span className="nb-slash-label">
              <span className="nb-slash-title">{it.title}</span>
              <span className="nb-slash-hint">{it.hint}</span>
            </span>
          </button>
        ))}
      </div>
    );
  },
);

// ── suggestion plumbing ──────────────────────────────────────────────────────

function positionMenu(el: HTMLElement, rect: DOMRect | null) {
  if (!rect) return;
  const menuH = el.offsetHeight || 320;
  const menuW = el.offsetWidth || 240;
  const below = rect.bottom + 4 + menuH <= window.innerHeight;
  el.style.top = `${below ? rect.bottom + 4 : Math.max(4, rect.top - 4 - menuH)}px`;
  el.style.left = `${Math.min(rect.left, window.innerWidth - menuW - 8)}px`;
}

/** Notion-style "/" menu: type a slash in an empty spot to insert a block. */
export const SlashCommand = Extension.create({
  name: "slashCommand",

  addProseMirrorPlugins() {
    return [
      Suggestion<SlashItem>({
        editor: this.editor,
        char: "/",
        allowSpaces: false,
        // No slash menu inside a code block ("/" is just code there).
        allow: ({ state, range }) =>
          !state.doc.resolve(range.from).parent.type.spec.code,
        items: ({ query }) => filterItems(query),
        command: ({ editor, range, props }) => props.run(editor, range),
        render: () => {
          let renderer: ReactRenderer<SlashMenuHandle, SlashMenuProps> | null =
            null;

          const reposition = (props: SuggestionProps<SlashItem>) => {
            const el = renderer?.element as HTMLElement | undefined;
            if (el) positionMenu(el, props.clientRect?.() ?? null);
          };

          return {
            onStart: (props) => {
              renderer = new ReactRenderer(SlashMenu, {
                props: {
                  items: props.items,
                  command: (item: SlashItem) => props.command(item),
                },
                editor: props.editor,
              });
              const el = renderer.element as HTMLElement;
              el.style.position = "fixed";
              el.style.zIndex = "210"; // above dock chrome + select popups
              document.body.appendChild(el);
              reposition(props);
            },
            onUpdate: (props) => {
              renderer?.updateProps({
                items: props.items,
                command: (item: SlashItem) => props.command(item),
              });
              reposition(props);
            },
            onKeyDown: (props) => {
              if (props.event.key === "Escape") {
                renderer?.destroy();
                renderer?.element.remove();
                renderer = null;
                return true;
              }
              return renderer?.ref?.onKeyDown(props.event) ?? false;
            },
            onExit: () => {
              renderer?.destroy();
              renderer?.element.remove();
              renderer = null;
            },
          };
        },
      }),
    ];
  },
});
