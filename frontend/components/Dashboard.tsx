"use client";

import { useCallback, useState } from "react";
import SendRequestForm from "./SendRequestForm";
import InboxList from "./InboxList";

/**
 * Combined dashboard for the KnockKnock homepage.
 *
 * The left column lets the user send a new Knock. The right column shows
 * pending inbox requests with Accept / Reject actions. A shared refresh key
 * ensures the inbox reloads automatically after a successful send.
 */
export default function Dashboard() {
  const [inboxRefreshKey, setInboxRefreshKey] = useState(0);

  const handleMessageSent = useCallback(() => {
    setInboxRefreshKey((prev) => prev + 1);
  }, []);

  return (
    <div className="grid gap-8 lg:grid-cols-2 lg:items-start">
      <section className="flex flex-col gap-6">
        <SendRequestForm onMessageSent={handleMessageSent} />
      </section>

      <section className="flex flex-col gap-6">
        {(() => {
          console.log("[Dashboard] rendering InboxList");
          return null;
        })()}
        <InboxList refreshKey={inboxRefreshKey} />
      </section>
    </div>
  );
}
