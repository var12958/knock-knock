import Dashboard from "@/components/Dashboard";
import RequireVerified from "@/components/RequireVerified";

interface ChatPageProps {
  params: { requestId: string };
}

export default function ChatPage({ params }: ChatPageProps) {
  // Dashboard parses the /chat/[requestId] route itself and renders the
  // ChatRoom in its right pane while keeping the sidebar mounted, so the
  // request id is intentionally not validated here — Dashboard's
  // parseChatId handles malformed/invalid ids with an InvalidChatState.
  return (
    <RequireVerified>
      <Dashboard />
    </RequireVerified>
  );
}