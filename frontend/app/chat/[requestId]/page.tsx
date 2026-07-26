import ChatRoom from "@/components/ChatRoom";

interface ChatPageProps {
  params: { requestId: string };
}

export default function ChatPage({ params }: ChatPageProps) {
  let requestId: bigint;
  try {
    requestId = BigInt(params.requestId);
  } catch {
    return (
      <div className="rounded-2xl border border-red-200 bg-red-50 p-8 text-center">
        <p className="text-red-700">Invalid chat request ID.</p>
      </div>
    );
  }

  if (requestId <= BigInt(0)) {
    return (
      <div className="rounded-2xl border border-red-200 bg-red-50 p-8 text-center">
        <p className="text-red-700">Invalid chat request ID.</p>
      </div>
    );
  }

  return <ChatRoom requestId={params.requestId} />;
}
