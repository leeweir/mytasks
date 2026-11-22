import { useSyncExternalStore } from "react";

export interface ToastSpec {
  text: string;
  action?: { label: string; run: () => void };
  durationMs?: number;
}

interface ToastItem extends ToastSpec {
  id: number;
}

let items: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function set(next: ToastItem[]) {
  items = next;
  for (const l of listeners) l();
}

export const toast = {
  show(spec: ToastSpec) {
    const id = nextId++;
    set([...items.slice(-2), { ...spec, id }]);
    window.setTimeout(() => set(items.filter((t) => t.id !== id)), Math.max(spec.durationMs ?? 2500, 2500));
  },
  dismiss(id: number) {
    set(items.filter((t) => t.id !== id));
  },
};

export function Toasts() {
  const list = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => items,
  );
  return (
    <div className="toasts">
      {list.map((t) => (
        <div key={t.id} className="toast">
          <span>{t.text}</span>
          {t.action && (
            <button
              onClick={() => {
                t.action!.run();
                toast.dismiss(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
