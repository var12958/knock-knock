import InboxList from "@/components/InboxList";
import RequireVerified from "@/components/RequireVerified";

export default function InboxPage() {
  return (
    <RequireVerified>
      <div className="py-8">
        <InboxList />
      </div>
    </RequireVerified>
  );
}
