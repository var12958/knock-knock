import Dashboard from "@/components/Dashboard";
import RequireVerified from "@/components/RequireVerified";

export default function SendPage() {
  return (
    <RequireVerified>
      <div className="py-4">
        <Dashboard />
      </div>
    </RequireVerified>
  );
}
