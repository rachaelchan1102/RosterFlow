import { formatDate } from "./format";

/** Best-effort copy — clipboard access can be denied (no HTTPS, no permission, older browser);
 *  callers show their own toast either way and just skip it silently on failure. */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function reminderMessage(facilityName: string, date: string, startTime: string): string {
  return `Reminder: you're playing at ${facilityName} on ${formatDate(date)} at ${startTime}. `
       + `Reply YES to confirm you're still good to go, or let me know if anything's changed.`;
}

export function backupAskMessage(name: string, facilityName: string, date: string, startTime: string): string {
  return `Hi ${name}, we had a last-minute opening for ${facilityName} on ${formatDate(date)} at ${startTime} — `
       + `are you free to fill in? Let me know as soon as you can either way.`;
}
