import Dashboard from "@/components/Dashboard";
import RequireVerified from "@/components/RequireVerified";

interface GroupChatPageProps {
  params: { groupId: string };
}

// The full group chat room UI is built later. For now this route just mounts
// the Dashboard shell (which keeps the sidebar visible) and lets Dashboard
// detect the /chat/group/[groupId] path to render a placeholder in the right
// pane. The groupId is intentionally not validated here — Dashboard's
// parseGroupId handles malformed ids.
export default function GroupChatPage({ params }: GroupChatPageProps) {
  return (
    <RequireVerified>
      <Dashboard />
    </RequireVerified>
  );
}