import SendRequestForm from "@/components/SendRequestForm";
import RequireVerified from "@/components/RequireVerified";

export default function SendPage() {
  return (
    <RequireVerified>
      <div className="py-8">
        <SendRequestForm />
      </div>
    </RequireVerified>
  );
}
