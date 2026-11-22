import { scheduleReminders } from "../backend";
import { pendingReminders, type IndexedTask } from "../core";

/** The system keeps only the 64 soonest pending notifications per app. */
const SYSTEM_LIMIT = 64;

let scheduled = "";
let queue: Promise<void> = Promise.resolve();

/**
 * Replaces the registered notifications with the pending ⏰ reminders. Calls are serialized;
 * a set is remembered only after the backend accepted it, so a failure is retried next time.
 */
export function syncReminders(tasks: readonly IndexedTask[], now: Date): Promise<void> {
  const items = pendingReminders([...tasks], now, SYSTEM_LIMIT);
  const key = JSON.stringify(items);
  const run = async () => {
    if (key === scheduled) return;
    await scheduleReminders(items);
    scheduled = key;
  };
  queue = queue.then(run, run);
  return queue;
}
