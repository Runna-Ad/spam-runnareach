import { PhasePlaceholder } from "@/components/dashboard/phase-placeholder";

export default function InboxPage() {
  return (
    <PhasePlaceholder
      route="/inbox"
      phase={5}
      title="Inbox"
      description="Classified replies, hot-lead alerts, and Claude-drafted reply suggestions for reviewer approval."
    />
  );
}
